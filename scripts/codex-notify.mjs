import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "../dist/channels/telegram.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = join(homedir(), ".echoloop", "codex-notify");

async function ensureReplyReceiver() {
  const directory = join(homedir(), ".echoloop", "codex-replies");
  try {
    const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
    process.kill(status.pid, 0);
    return;
  } catch { /* Start a receiver if the previous process is no longer running. */ }
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  const child = spawn(process.execPath, [`--env-file=${join(project, ".env")}`,
    join(project, "scripts", "codex-replies.mjs"), settings.codex], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

export function notificationText(event) {
  if (event.type !== "agent-turn-complete" || !event.cwd ||
      resolve(event.cwd).toLowerCase() !== project.toLowerCase()) return null;
  const text = event["last-assistant-message"];
  if (typeof text !== "string" || !text.trim()) return null;
  return `[EchoLoop · ${(event["thread-id"] ?? "").slice(-8)}]\n${text}`;
}

export async function forward(event) {
  const text = notificationText(event);
  if (!text) return;
  await ensureReplyReceiver();
  await mkdir(stateDirectory, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify([
    event["thread-id"], event["turn-id"], text,
  ])).digest("hex");
  const marker = join(stateDirectory, key);
  try {
    await mkdir(marker);
  } catch (error) {
    if (error.code === "EEXIST") return;
    throw error;
  }
  try {
    const channel = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    await channel.sendToThread(text, event["thread-id"]);
    await writeFile(join(stateDirectory, "last-sent.json"), JSON.stringify({
      at: new Date().toISOString(), threadId: event["thread-id"], turnId: event["turn-id"],
    }));
  } catch (error) {
    await rmdir(marker);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = process.argv[2];
  // Preserve the desktop app's existing turn-ended notification handler.
  const original = JSON.parse(await readFile(join(stateDirectory, "original.json"), "utf8"));
  if (original.length > 0) {
    const child = spawn(original[0], [...original.slice(1), payload], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
  }
  try {
    await forward(JSON.parse(payload));
  } catch {
    console.error("EchoLoop automatic Telegram notification failed.");
    process.exitCode = 1;
  }
}
