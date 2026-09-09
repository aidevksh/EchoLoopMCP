import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import test from "node:test";
import { notificationText } from "../scripts/codex-notify.mjs";
import { projectKey } from "../scripts/settings.mjs";

test("automatic notification includes only this project's completed answer", () => {
  const event = { type: "agent-turn-complete", cwd: fileURLToPath(new URL("..", import.meta.url)),
    "thread-id": "thread-12345678", "last-assistant-message": "완료했습니다." };
  const settings = { projects: { [projectKey(event.cwd)]: true } };
  assert.equal(notificationText(event, settings), `[${basename(event.cwd)} · 12345678]\n완료했습니다.`);
  assert.equal(notificationText({ ...event, type: "other" }, settings), null);
  assert.equal(notificationText({ ...event, cwd: fileURLToPath(new URL("../..", import.meta.url)) }, settings), null);
  assert.equal(notificationText({ ...event, "last-assistant-message": "" }, settings), null);
  settings.projects[projectKey(event.cwd)] = false;
  assert.equal(notificationText(event, settings), null);
});
