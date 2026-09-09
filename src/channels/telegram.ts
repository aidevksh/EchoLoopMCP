import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { truncate, type Channel } from "./index.js";

const MAX_LEN = 4096;

interface Update {
  update_id: number;
  message?: {
    text?: string;
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
}

export interface ThreadReply {
  updateId: number;
  threadId: string;
  text: string;
}

export class TelegramChannel implements Channel {
  readonly canReceive = true;
  private readonly directory: string;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
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
      while (Date.now() < deadline) {
        const chatId = await this.withState(async (state) => {
          if (!state.pairing?.chatId) await this.poll(state, 1);
          return state.pairing?.chatId ?? null;
        });
        if (chatId) return chatId;
        await sleep(100);
      }
      return null;
    } finally {
      await this.withState(async (state) => { if (state.pairing?.code === code) delete state.pairing; });
    }
  }

  async send(text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: this.chatId, text: truncate(text, MAX_LEN) }, 0);
  }

  async sendToThread(text: string, threadId: string): Promise<void> {
    await this.withState(async (state) => {
      const sent = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId, text: truncate(text, MAX_LEN),
      }, 0);
      (state.routes ??= {})[`${this.chatId}:${sent.message_id}`] = threadId;
    });
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
    return this.withState(async (state) => {
      await this.poll(state, 1);
      return state.inbox ?? [];
    });
  }

  async acknowledgeThreadReply(updateId: number): Promise<void> {
    await this.withState(async (state) => {
      state.inbox = (state.inbox ?? []).filter((reply) => reply.updateId !== updateId);
    });
  }

  async ask(text: string, timeoutSec: number): Promise<string | null> {
    let deadline = 0;
    const key = await this.withState(async (state) => {
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
    });

    try {
      while (Date.now() < deadline) {
        const reply = await this.withState(async (state) => {
          if (state.pending[key]?.reply !== undefined) return state.pending[key].reply;
          if (Date.now() >= deadline) return null;
          // Keep the shared lock short so other sessions can send and read.
          await this.poll(state, Math.min(1, Math.floor((deadline - Date.now()) / 1000)));
          return state.pending[key]?.reply ?? null;
        });
        if (reply !== null) return reply;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      }
      return null;
    } finally {
      await this.withState(async (state) => { delete state.pending[key]; });
    }
  }

  private async poll(state: State, timeoutSec: number): Promise<void> {
    const updates = await this.call<Update[]>("getUpdates", {
      offset: state.offset, timeout: timeoutSec, allowed_updates: ["message"],
    }, timeoutSec);
    for (const update of updates) {
      if (update.update_id < state.offset) continue;
      const message = update.message;
      if (state.pairing && state.pairing.deadline > Date.now() &&
          message?.chat.type === "private" && message.text === `/start ${state.pairing.code}`) {
        state.pairing.chatId ??= String(message.chat.id);
      }
      if (message?.text && message.reply_to_message) {
        const key = `${message.chat.id}:${message.reply_to_message.message_id}`;
        const target = state.pending[key];
        if (target && target.deadline > Date.now()) target.reply ??= message.text;
        let threadId = state.routes?.[key];
        const original = message.reply_to_message;
        if (!threadId && original.text && String(original.from?.id) === this.token.split(":")[0]) {
          const previousKey = createHash("sha256").update(`${message.chat.id}:${original.text}`).digest("hex");
          threadId = state.previousNotifications?.[previousKey];
          if (threadId) (state.routes ??= {})[key] = threadId;
        }
        if (threadId) (state.inbox ??= []).push({ updateId: update.update_id, threadId, text: message.text });
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
      let state: State;
      try {
        state = JSON.parse(await readFile(path, "utf8")) as State;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = { offset: 0, pending: {} };
      }
      for (const [key, pending] of Object.entries(state.pending)) {
        if (pending.deadline <= Date.now()) delete state.pending[key];
      }
      const result = await action(state);
      // Persist replies before the next getUpdates acknowledges their offsets.
      await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return result;
    } finally {
      await release();
    }
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
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
    return body.result as T;
  }
}
