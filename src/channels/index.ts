export interface Channel {
  /** Human-readable label, e.g. "Telegram (chat 12345)". */
  readonly label: string;
  /** False for channels that can only push (Discord webhooks). */
  readonly canReceive: boolean;
  send(text: string): Promise<void>;
  /** Send a question and return its reply, or null when the timeout expires. */
  ask(text: string, timeoutSec: number): Promise<string | null>;
}

import { TelegramChannel } from "./telegram.js";
import { DiscordBotChannel, DiscordWebhookChannel } from "./discord.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TIMEOUT_SEC = Number(process.env.ECHOLOOP_TIMEOUT ?? 240);

const SETUP_HELP = `EchoLoop has no channel configured. Set one of:

  Telegram (two-way):
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  Discord (two-way):
    DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID
  Discord (notify only):
    DISCORD_WEBHOOK_URL`;

/** Pick a channel from whichever credentials are present. */
export function createChannel(): Channel {
  const env = { ...process.env };
  if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID && !env.DISCORD_BOT_TOKEN && !env.DISCORD_WEBHOOK_URL) {
    try {
      const saved = JSON.parse(readFileSync(join(homedir(), ".echoloop", "config.json"), "utf8"));
      env.TELEGRAM_BOT_TOKEN = saved.telegram?.token;
      env.TELEGRAM_CHAT_ID = saved.telegram?.chatId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const prefer = env.ECHOLOOP_CHANNEL?.toLowerCase();

  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramChannel(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID)
      : null;

  const discord =
    env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID
      ? new DiscordBotChannel(env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID)
      : env.DISCORD_WEBHOOK_URL
        ? new DiscordWebhookChannel(env.DISCORD_WEBHOOK_URL)
        : null;

  if (prefer === "telegram" && telegram) return telegram;
  if (prefer === "discord" && discord) return discord;
  if (prefer && prefer !== "telegram" && prefer !== "discord") {
    throw new Error(`ECHOLOOP_CHANNEL must be "telegram" or "discord", got "${prefer}"`);
  }
  if (prefer) throw new Error(`ECHOLOOP_CHANNEL=${prefer} but its credentials are missing.\n\n${SETUP_HELP}`);

  const chosen = telegram ?? discord;
  if (!chosen) throw new Error(SETUP_HELP);
  return chosen;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
