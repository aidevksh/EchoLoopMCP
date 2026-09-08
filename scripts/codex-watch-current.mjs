import { open, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { forward } from "./codex-notify.mjs";

// Bridge the already-running task until the new notify setting is loaded.
const [rollout, statusPath] = process.argv.slice(2);
const existing = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
const context = existing.findLast((item) => item.type === "turn_context").payload;
const meta = existing.find((item) => item.type === "session_meta").payload;
let turnId = context.turn_id;
const handle = await open(rollout, "r");
let offset = (await handle.stat()).size;
let buffer = "";
const decoder = new StringDecoder("utf8");
await writeFile(statusPath, JSON.stringify({ pid: process.pid, status: "ready" }));
try {
  // Stay attached to this live task; the regular notify hook handles new tasks.
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) { await sleep(500); continue; }
    offset += bytesRead;
    buffer += decoder.write(chunk.subarray(0, bytesRead));
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === "turn_context") turnId = record.payload.turn_id;
      const message = record.payload;
      if (record.type !== "response_item" || message.role !== "assistant" || !["final", "final_answer"].includes(message.phase)) continue;
      await forward({ type: "agent-turn-complete", cwd: context.cwd,
        "thread-id": meta.id, "turn-id": turnId,
        "last-assistant-message": message.content.filter((item) => item.type === "output_text").map((item) => item.text).join("\n"),
      });
      await writeFile(statusPath, JSON.stringify({ pid: process.pid, status: "sent", at: new Date().toISOString() }));
    }
  }
} finally {
  await handle.close();
}
