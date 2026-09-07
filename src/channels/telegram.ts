import { truncate, type Channel } from "./index.js";

const MAX_LEN = 4096;
/** Telegram caps long polling at 50s; stay well under any proxy idle limit. */
const POLL_SEC = 25;

interface Update {
  update_id: number;
  message?: { text?: string; chat: { id: number } };
}

export class TelegramChannel implements Channel {
  readonly canReceive = true;
  private offset = 0;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  get label(): string {
    return `Telegram (chat ${this.chatId})`;
  }

  async send(text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: this.chatId, text: truncate(text, MAX_LEN) }, 0);
  }

  async drain(): Promise<void> {
    // Loop because getUpdates returns at most 100 per call.
    while ((await this.poll(0)).length > 0) {
      /* keep advancing the offset */
    }
  }

  async waitForReply(deadline: number): Promise<string | null> {
    for (;;) {
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      if (remaining <= 0) return null;
      for (const update of await this.poll(Math.min(POLL_SEC, remaining))) {
        const message = update.message;
        if (message?.text && String(message.chat.id) === this.chatId) return message.text;
      }
    }
  }

  private async poll(timeoutSec: number): Promise<Update[]> {
    const updates = await this.call<Update[]>(
      "getUpdates",
      { offset: this.offset, timeout: timeoutSec, allowed_updates: ["message"] },
      timeoutSec,
    );
    for (const update of updates) this.offset = Math.max(this.offset, update.update_id + 1);
    return updates;
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
