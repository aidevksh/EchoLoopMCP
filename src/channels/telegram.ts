import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { truncate, type Channel } from "./index.js";

const MAX_LEN = 4096;
/** getUpdates runs outside the state lock, so a long poll never makes other processes queue for the lock. */
const POLL_SEC = 25;
/** How often a process that is not polling checks the shared state. */
const CHECK_MS = 500;
/** A plain message this soon after a reply that reached a thread continues that thread. */
const FOLLOW_UP_MS = 10 * 60_000;
const MAX_ROUTES = 1000;

interface Update {
  update_id: number;
  message?: {
    text?: string;
    date?: number;
    chat: { id: number; type?: string };
    reply_to_message?: { message_id: number; text?: string; from?: { id: number } };
  };
}

interface PendingReply {
  deadline: number;
  reply?: string;
}

interface State {
  offset: number;
  pending: Record<string, PendingReply>;
  routes?: Record<string, string>;
  inbox?: ThreadReply[];
  previousNotifications?: Record<string, string>;
  pairing?: { code: string; deadline: number; chatId?: string };
  /** Only the lease owner calls getUpdates until `until`. */
  poller?: { owner: string; pid: number; until: number };
  /** The latest wait per thread; an older wait for the same thread ends. */
  waiters?: Record<string, { id: string; deadline: number }>;
  lastReply?: { chatId: string; threadId: string; at: number };
}

export interface ThreadReply {
  updateId: number;
  threadId: string;
  text: string;
  at?: number;
}

class TelegramError extends Error {
  constructor(message: string, readonly errorCode?: number, readonly retryAfter?: number) {
    super(message);
  }
}

/** Network, timeout, lock and file errors are retried; Telegram rejections are not, except conflicts, rate limits and server errors. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return true;
  const code = error.errorCode ?? 0;
  return code === 409 || code === 429 || code >= 500;
}

function retryDelay(error: unknown, failures: number): number {
  if (error instanceof TelegramError && error.retryAfter) return error.retryAfter * 1000;
  return Math.min(30_000, 500 * 2 ** failures);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class TelegramChannel implements Channel {
  readonly canReceive = true;
  private readonly directory: string;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly onError?: (message: string) => void,
  ) {
    // Share one update cursor across all MCP processes and chats for this bot.
    const botKey = createHash("sha256").update(token).digest("hex");
    this.directory = join(homedir(), ".echoloop", "telegram", botKey);
  }

  get label(): string {
    return `Telegram (chat ${this.chatId})`;
  }

  async botUsername(): Promise<string> {
    const bot = await this.call<{ username: string }>("getMe", {}, 0);
    const webhook = await this.call<{ url: string }>("getWebhookInfo", {}, 0);
    if (webhook.url) throw new Error("This bot has a webhook. Remove it before connecting EchoLoop.");
    return bot.username;
  }

  async discoverChat(code: string, timeoutSec = 120): Promise<string | null> {
    const deadline = Date.now() + timeoutSec * 1000;
    await this.withState(async (state) => {
      if (state.pairing && state.pairing.deadline > Date.now()) throw new Error("Another setup is already pairing this bot.");
      state.pairing = { code, deadline };
    });
    try {
      return await this.waitFor((state) => state.pairing?.chatId, deadline);
    } finally {
      await this.withState(async (state) => { if (state.pairing?.code === code) delete state.pairing; });
    }
  }

  async send(text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: this.chatId, text: truncate(text, MAX_LEN) }, 0);
  }

  async sendToThread(text: string, threadId: string, { forceReply = false } = {}): Promise<void> {
    await this.retry(() => this.withState(async (state) => {
      // Register before another process can poll an immediate reply.
      const sent = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId, text: truncate(text, MAX_LEN),
        ...(forceReply ? { reply_markup: { force_reply: true } } : {}),
      }, 0);
      const routes = (state.routes ??= {});
      routes[`${this.chatId}:${sent.message_id}`] = threadId;
      for (const key of Object.keys(routes).slice(0, -MAX_ROUTES)) delete routes[key];
    }));
  }

  async registerPreviousNotifications(texts: string[], threadId: string): Promise<void> {
    await this.withState(async (state) => {
      for (const text of texts) {
        const key = createHash("sha256").update(`${this.chatId}:${truncate(text, MAX_LEN)}`).digest("hex");
        (state.previousNotifications ??= {})[key] = threadId;
      }
    });
  }

  async receiveThreadReplies(): Promise<ThreadReply[]> {
    const owner = randomUUID();
    const lease = await this.withState(async (state) => this.claimPoll(state, owner, Date.now() + POLL_SEC * 1000));
    if (lease) await this.pollFrom(owner, lease);
    return this.withState(async (state) => state.inbox ?? []);
  }

  async acknowledgeThreadReply(updateId: number): Promise<void> {
    await this.withState(async (state) => {
      state.inbox = (state.inbox ?? []).filter((reply) => reply.updateId !== updateId);
    });
  }

  /** Wait for replies routed to a thread. Returns null on timeout or once a newer wait for the same thread starts. */
  async waitForThread(threadId: string, timeoutSec: number): Promise<string[] | null> {
    const id = randomUUID();
    const deadline = Date.now() + timeoutSec * 1000;
    await this.retry(() => this.withState(async (state) => { (state.waiters ??= {})[threadId] = { id, deadline }; }));
    try {
      return await this.waitFor((state) => {
        if (state.waiters?.[threadId]?.id !== id) return null;
        const inbox = state.inbox ?? [];
        const replies = inbox.filter((reply) => reply.threadId === threadId);
        if (!replies.length) return undefined;
        state.inbox = inbox.filter((reply) => reply.threadId !== threadId);
        // A reply queued longer ago than a whole wait is no longer a live instruction.
        const live = replies.filter((reply) => reply.at === undefined || reply.at > Date.now() - timeoutSec * 1000);
        return live.length ? live.map((reply) => reply.text) : undefined;
      }, deadline);
    } finally {
      await this.withState(async (state) => {
        if (state.waiters?.[threadId]?.id === id) delete state.waiters[threadId];
      }).catch((error) => this.report(error));
    }
  }

  async ask(text: string, timeoutSec: number): Promise<string | null> {
    let deadline = 0;
    const key = await this.retry(() => this.withState(async (state) => {
      // Register before another process can poll an immediate reply.
      const sent = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        text: truncate(text, MAX_LEN),
        reply_markup: { force_reply: true },
      }, 0);
      const key = `${this.chatId}:${sent.message_id}`;
      deadline = Date.now() + timeoutSec * 1000;
      state.pending[key] = { deadline };
      return key;
    }));

    try {
      return await this.waitFor((state) => state.pending[key]?.reply, deadline);
    } finally {
      await this.withState(async (state) => { delete state.pending[key]; }).catch((error) => this.report(error));
    }
  }

  /** Poll Telegram when no other process is polling, otherwise watch the shared state; null from check ends the wait. */
  private async waitFor<T>(check: (state: State) => T | null | undefined, deadline: number): Promise<T | null> {
    const owner = randomUUID();
    let failures = 0;
    while (Date.now() < deadline) {
      try {
        const step = await this.withState(async (state) => {
          const result = check(state);
          return result === undefined ? { lease: this.claimPoll(state, owner, deadline) } : { result };
        });
        if ("result" in step) return step.result ?? null;
        if (step.lease) await this.pollFrom(owner, step.lease);
        failures = 0;
        await sleep(Math.min(step.lease ? 100 : CHECK_MS, Math.max(0, deadline - Date.now())));
      } catch (error) {
        // One failed request or lock wait must not abandon a wait that can last a day.
        if (!isTransient(error)) throw error;
        this.report(error);
        await sleep(Math.min(retryDelay(error, ++failures), Math.max(0, deadline - Date.now())));
      }
    }
    return null;
  }

  /** Take the poll lease unless another live process holds it; the lease outlasts one getUpdates call. */
  private claimPoll(state: State, owner: string, deadline: number): { offset: number; timeout: number } | undefined {
    const lease = state.poller;
    if (lease && lease.owner !== owner && lease.until > Date.now() && isAlive(lease.pid)) return undefined;
    const timeout = Math.max(0, Math.min(POLL_SEC, Math.floor((deadline - Date.now()) / 1000)));
    state.poller = { owner, pid: process.pid, until: Date.now() + (timeout + 15) * 1000 };
    return { offset: state.offset, timeout };
  }

  private async pollFrom(owner: string, { offset, timeout }: { offset: number; timeout: number }): Promise<void> {
    const release = (state: State) => { if (state.poller?.owner === owner) delete state.poller; };
    let updates: Update[];
    try {
      updates = await this.call<Update[]>("getUpdates", { offset, timeout, allowed_updates: ["message"] }, timeout);
    } catch (error) {
      await this.withState(async (state) => release(state)).catch(() => {});
      throw error;
    }
    // Persist replies before the next getUpdates acknowledges their offsets.
    await this.withState(async (state) => {
      this.apply(state, updates);
      release(state);
    });
  }

  private apply(state: State, updates: Update[]): void {
    for (const update of updates) {
      if (update.update_id < state.offset) continue;
      const message = update.message;
      if (state.pairing && state.pairing.deadline > Date.now() &&
          message?.chat.type === "private" && message.text === `/start ${state.pairing.code}`) {
        state.pairing.chatId ??= String(message.chat.id);
      }
      const text = message?.text;
      if (message && text) {
        const chatId = String(message.chat.id);
        const at = message.date === undefined ? Date.now() : message.date * 1000;
        let threadId: string | undefined;
        if (message.reply_to_message) {
          const key = `${chatId}:${message.reply_to_message.message_id}`;
          const target = state.pending[key];
          if (target && target.deadline > Date.now()) target.reply ??= text;
          threadId = state.routes?.[key];
          const original = message.reply_to_message;
          if (!threadId && original.text && String(original.from?.id) === this.token.split(":")[0]) {
            const previousKey = createHash("sha256").update(`${chatId}:${original.text}`).digest("hex");
            threadId = state.previousNotifications?.[previousKey];
            if (threadId) (state.routes ??= {})[key] = threadId;
          }
          // Only a reply that reached a thread can be continued by plain follow-up messages.
          state.lastReply = threadId ? { chatId, threadId, at } : undefined;
        } else if (!text.startsWith("/") && state.lastReply?.chatId === chatId && at - state.lastReply.at <= FOLLOW_UP_MS) {
          // Telegram clears the reply target after one message, so a quick follow-up arrives as plain text.
          threadId = state.lastReply.threadId;
          state.lastReply.at = at;
        }
        if (threadId) {
          (state.inbox ??= []).push({ updateId: update.update_id, threadId, text, ...(message.date === undefined ? {} : { at }) });
        }
      }
      state.offset = Math.max(state.offset, update.update_id + 1);
    }
  }

  private async withState<T>(action: (state: State) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.directory, {
      realpath: false,
      stale: 60_000,
      retries: { retries: 1200, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
    try {
      const path = join(this.directory, "state.json");
      let saved: string | undefined;
      try {
        saved = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const state: State = saved === undefined ? { offset: 0, pending: {} } : JSON.parse(saved);
      for (const [key, pending] of Object.entries(state.pending)) {
        if (pending.deadline <= Date.now()) delete state.pending[key];
      }
      for (const [key, waiter] of Object.entries(state.waiters ?? {})) {
        if (waiter.deadline <= Date.now()) delete state.waiters![key];
      }
      const result = await action(state);
      const next = JSON.stringify(state);
      // Most calls only look for a reply; skipping unchanged writes keeps the lock short.
      if (next !== saved) {
        await writeFile(`${path}.tmp`, next, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
      return result;
    } finally {
      await release();
    }
  }

  /** Retry a send on transient errors; a lost response can duplicate a message but never drop it. */
  private async retry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
    for (let failures = 1; ; failures++) {
      try {
        return await operation();
      } catch (error) {
        if (failures >= attempts || !isTransient(error)) throw error;
        this.report(error);
        await sleep(retryDelay(error, failures));
      }
    }
  }

  private report(error: unknown): void {
    if (!this.onError) return;
    let detail = String(error);
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      detail = `${error.name}${code ? ` ${code}` : ""}: ${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`;
    }
    this.onError(this.token ? detail.replaceAll(this.token, "<token>") : detail);
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutSec: number,
  ): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout((timeoutSec + 15) * 1000),
    });
    const body = (await res.json()) as {
      ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number };
    };
    if (!body.ok) {
      throw new TelegramError(`Telegram ${method} failed: ${body.description ?? res.status}`, body.error_code, body.parameters?.retry_after);
    }
    return body.result as T;
  }
}
