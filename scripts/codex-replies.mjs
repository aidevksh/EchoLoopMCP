import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { TelegramChannel } from "../dist/channels/telegram.js";
import { readSettings, telegramCredentials } from "./settings.mjs";

const run = promisify(execFile);
const directory = join(homedir(), ".echoloop", "codex-replies");
await mkdir(directory, { recursive: true });
// Only one dispatcher may submit each stored reply to Codex.
const release = await lockfile.lock(directory, { realpath: false, stale: 60_000 });
const { token, chatId } = telegramCredentials(await readSettings());
const channel = new TelegramChannel(token, chatId);
await writeFile(join(directory, "status.json"), JSON.stringify({ pid: process.pid, status: "ready" }));
try {
  for (;;) {
    try {
      for (const reply of await channel.receiveThreadReplies()) {
        await run(process.argv[2], [...process.argv.slice(3), "queue", "--thread", reply.threadId, "--message",
          `[텔레그램 답장 · ${reply.updateId}]\n${reply.text}`], { windowsHide: true, timeout: 30_000 });
        await channel.acknowledgeThreadReply(reply.updateId);
        await writeFile(join(directory, "status.json"), JSON.stringify({
          pid: process.pid, status: "queued", updateId: reply.updateId, threadId: reply.threadId,
          at: new Date().toISOString(),
        }));
      }
    } catch {
      // Leave unsubmitted replies in the durable inbox for a later retry.
      await writeFile(join(directory, "status.json"), JSON.stringify({ pid: process.pid, status: "retrying" }));
      await sleep(5000);
    }
    await sleep(250);
  }
} finally {
  await release();
}
