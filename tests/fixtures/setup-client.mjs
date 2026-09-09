import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Exercise installation without depending on a real Codex executable or account.
childProcess.execFileSync = (command, args) => {
  if (args[0] === "codex") return `${process.execPath}\n`;
  if (args[0] === "queue" && args[1] === "--help") return "";
  throw new Error(`Unexpected command: ${command}`);
};
syncBuiltinESMExports();
const { main } = await import("../../scripts/echoloop.mjs");

let resolveCode;
const code = new Promise((resolve) => { resolveCode = resolve; });
process.on("message", (message) => resolveCode(message.code));
globalThis.fetch = async (url) => ({ json: async () => {
  const method = url.split("/").pop();
  if (method === "getMe") return { ok: true, result: { username: "test_bot" } };
  if (method === "getWebhookInfo") return { ok: true, result: { url: "" } };
  if (method === "getUpdates") return { ok: true, result: [{ update_id: 1,
    message: { text: `/start ${await code}`, chat: { id: 987, type: "private" } } }] };
  throw new Error(`Unexpected method: ${method}`);
} });
await main(["setup"]);
process.disconnect();
