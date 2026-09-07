import { truncate, type Channel } from "./index.js";

const MAX_LEN = 2000;
const API = "https://discord.com/api/v10";
const POLL_MS = 3000;
const DISCORD_EPOCH = 1420070400000n;

/** Synthetic snowflake for "now", so we can ask only for messages sent after this instant. */
function snowflakeFor(epochMs: number): string {
  return ((BigInt(epochMs) - DISCORD_EPOCH) << 22n).toString();
}

interface Message {
  id: string;
  content: string;
  author: { bot?: boolean };
}

/** Bot token + channel id: can both send and read replies. */
export class DiscordBotChannel implements Channel {
  readonly canReceive = true;
  private after = snowflakeFor(Date.now());

  constructor(
    private readonly token: string,
    private readonly channelId: string,
  ) {}

  get label(): string {
    return `Discord (channel ${this.channelId})`;
  }

  async send(text: string): Promise<void> {
    await this.request("POST", `/channels/${this.channelId}/messages`, {
      content: truncate(text, MAX_LEN),
    });
  }

  async drain(): Promise<void> {
    this.after = snowflakeFor(Date.now());
  }

  async waitForReply(deadline: number): Promise<string | null> {
    for (;;) {
      // Newest first; walk it back to chronological order.
      const messages = (
        await this.request<Message[]>(
          "GET",
          `/channels/${this.channelId}/messages?after=${this.after}&limit=100`,
        )
      ).reverse();

      for (const message of messages) {
        this.after = message.id;
        // Our own sends (and webhook posts) are flagged as bots.
        if (!message.author.bot && message.content.trim()) return message.content;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, remaining)));
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Discord ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}

/** Webhook URL only: push notifications, no replies. */
export class DiscordWebhookChannel implements Channel {
  readonly canReceive = false;
  readonly label = "Discord webhook (one-way)";

  constructor(private readonly webhookUrl: string) {}

  async send(text: string): Promise<void> {
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: truncate(text, MAX_LEN) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    }
  }

  async drain(): Promise<void> {}

  async waitForReply(): Promise<string | null> {
    throw new Error("A Discord webhook cannot receive replies. Configure DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID for two-way use.");
  }
}
