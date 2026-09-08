import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { notificationText } from "../scripts/codex-notify.mjs";

test("automatic notification includes only this project's completed answer", () => {
  const event = { type: "agent-turn-complete", cwd: fileURLToPath(new URL("..", import.meta.url)),
    "thread-id": "thread-12345678", "last-assistant-message": "완료했습니다." };
  assert.equal(notificationText(event), "[EchoLoop · 12345678]\n완료했습니다.");
  assert.equal(notificationText({ ...event, type: "other" }), null);
  assert.equal(notificationText({ ...event, cwd: fileURLToPath(new URL("../..", import.meta.url)) }), null);
  assert.equal(notificationText({ ...event, "last-assistant-message": "" }), null);
});
