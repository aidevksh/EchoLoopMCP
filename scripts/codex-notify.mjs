import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "../dist/channels/telegram.js";
import { projectEnabled, readSettings, telegramCredentials } from "./settings.mjs";

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
  const child = spawn(process.execPath, [join(project, "scripts", "codex-replies.mjs"), settings.codex, ...(settings.codexArgs ?? [])], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

export async function readSessionMetadata(threadId, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  if (typeof threadId !== "string" || !threadId) return null;
  for (const directory of ["sessions", "archived_sessions"]) {
    const root = join(codexHome, directory);
    let files;
    try { files = await readdir(root, { recursive: true }); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const file = files.find((path) => path.endsWith(`-${threadId}.jsonl`));
    if (!file) continue;
    const stream = createReadStream(join(root, file), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const record = JSON.parse(line);
        return record.type === "session_meta" && record.payload?.id === threadId ? record.payload : null;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return null;
}

export function notificationText(event, settings, session) {
  if (event.type !== "agent-turn-complete" || !event.cwd ||
      !projectEnabled(settings, event.cwd)) return null;
  // Subagents and internal tasks also emit completion hooks, including their final reports to the parent.
  if (!session || session.id !== event["thread-id"] ||
      (session.thread_source && session.thread_source !== "user") || session.source === "subagent" ||
      (session.source && typeof session.source === "object" &&
        (Object.hasOwn(session.source, "subagent") || Object.hasOwn(session.source, "internal")))) return null;
  const text = event["last-assistant-message"];
  if (typeof text !== "string" || !text.trim()) return null;
  return `[${basename(event.cwd)} · ${(event["thread-id"] ?? "").slice(-8)}]\n${text}`;
}

export async function forward(event) {
  const settings = await readSettings();
  const session = await readSessionMetadata(event["thread-id"]);
  const text = notificationText(event, settings, session);
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
    const { token, chatId } = telegramCredentials(settings);
    const channel = new TelegramChannel(token, chatId);
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
