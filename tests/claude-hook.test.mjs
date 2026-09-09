import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { handleClaudeHook } from "../scripts/claude-hook.mjs";
import { mergeClaudeHooks } from "../scripts/echoloop.mjs";
import { projectKey } from "../scripts/settings.mjs";
import { collectAnswers, parseAnswer } from "../dist/questions.js";

const cwd = process.cwd();
const settings = { projects: { [projectKey(cwd)]: true } };
const question = { question: "어느 방식?", options: [{ label: "A" }, { label: "B" }] };

test("Claude Stop wakes the same active session only after a real reply", async () => {
  const event = { cwd, session_id: "session-12345678", hook_event_name: "Stop", last_assistant_message: "작업 완료", stop_hook_active: true };
  const messages = [];
  const result = await handleClaudeHook(event, settings, async (text) => { messages.push(text); return "테스트 실행해"; });
  assert.match(messages[0], /Claude.*12345678/);
  assert.match(result.wake, /테스트 실행해/);
  assert.deepEqual(await handleClaudeHook(event, settings, async () => null), {});
  assert.deepEqual(await handleClaudeHook({ ...event, cwd: join(cwd, "..") }, settings, async () => { throw new Error("must not send"); }), {});
});

test("Claude choices preserve tool input and resolve numbered multi-select answers", async () => {
  const multi = { ...question, question: "복수 선택?", multiSelect: true };
  const event = { cwd, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [question, multi], metadata: "preserved" } };
  const replies = ["2", "1,2"];
  const result = await handleClaudeHook(event, settings, async () => replies.shift());
  assert.deepEqual(result.hookSpecificOutput.updatedInput, { ...event.tool_input, answers: { "어느 방식?": "B", "복수 선택?": "A, B" } });
  assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
});

test("invalid numeric choices are retried and timeout never invents an answer", async () => {
  const replies = ["99", "2"];
  assert.deepEqual(await collectAnswers([question], async () => replies.shift(), 60), { "어느 방식?": "B" });
  assert.equal(await collectAnswers([question], async () => null, 60), null);
  assert.equal(parseAnswer(question, "1,2"), null);
  assert.equal(parseAnswer(question, "다른 방식으로 진행"), "다른 방식으로 진행");
});

test("Claude tool permission is granted only for an explicit allow reply", async () => {
  const event = { cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } };
  assert.equal((await handleClaudeHook(event, settings, async () => "1")).hookSpecificOutput.decision.behavior, "allow");
  for (const reply of ["2", "모르겠음", ""]) {
    assert.equal((await handleClaudeHook(event, settings, async () => reply)).hookSpecificOutput.decision.behavior, "deny");
  }
  assert.deepEqual(await handleClaudeHook(event, settings, async () => null), {});
  assert.deepEqual(await handleClaudeHook({ ...event, tool_input: { command: "x".repeat(4000) } }, settings, async () => { throw new Error("must not approve truncated details"); }), {});
});

test("Claude hook installation preserves existing settings and remains idempotent", () => {
  const existing = { permissions: { deny: ["Bash(rm *)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } };
  const installed = mergeClaudeHooks(existing, "node", "/app/scripts/claude-hook.mjs");
  assert.deepEqual(mergeClaudeHooks(installed, "node", "/app/scripts/claude-hook.mjs"), installed);
  assert.deepEqual(installed.permissions, existing.permissions);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "other");
  assert.equal(installed.hooks.Stop[1].hooks[0].asyncRewake, true);
  assert.equal(installed.hooks.PreToolUse[0].matcher, "AskUserQuestion");
});
