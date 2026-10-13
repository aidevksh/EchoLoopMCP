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

const stopEvent = { cwd, session_id: "session-12345678", hook_event_name: "Stop", last_assistant_message: "작업 완료", stop_hook_active: true };
const stopChannel = (replies, sent = []) => ({
  sendToThread: async (text, thread, options) => { sent.push({ text, thread, options }); },
  waitForThread: async (thread) => { assert.equal(thread, sent.at(-1).thread); return replies; },
});

test("Claude Stop wakes the same active session only after a real reply", async () => {
  const sent = [];
  const result = await handleClaudeHook(stopEvent, settings, stopChannel(["테스트 실행해"], sent));
  assert.match(sent[0].text, /Claude.*12345678/);
  assert.deepEqual([sent[0].thread, sent[0].options], ["claude:session-12345678", { forceReply: true }]);
  assert.match(result.wake, /테스트 실행해/);
  assert.deepEqual(await handleClaudeHook(stopEvent, settings, stopChannel(null)), {});
  assert.deepEqual(await handleClaudeHook({ ...stopEvent, cwd: join(cwd, "..") }, settings,
    { sendToThread: async () => { throw new Error("must not send"); } }), {});
});

test("several Telegram messages for one session wake it once, in order", async () => {
  const result = await handleClaudeHook(stopEvent, settings, stopChannel(["첫 번째 지시", "추가 지시"]));
  assert.match(result.wake, /다음 작업 지시:\n1\. 첫 번째 지시\n\n2\. 추가 지시$/);
});

test("Claude choices preserve tool input and resolve numbered multi-select answers", async () => {
  const multi = { ...question, question: "복수 선택?", multiSelect: true };
  const event = { cwd, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [question, multi], metadata: "preserved" } };
  const replies = ["2", "1,2"];
  const result = await handleClaudeHook(event, settings, { ask: async () => replies.shift() });
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
  const answer = (reply) => ({ ask: async () => reply });
  assert.equal((await handleClaudeHook(event, settings, answer("1"))).hookSpecificOutput.decision.behavior, "allow");
  for (const reply of ["2", "모르겠음", ""]) {
    assert.equal((await handleClaudeHook(event, settings, answer(reply))).hookSpecificOutput.decision.behavior, "deny");
  }
  assert.deepEqual(await handleClaudeHook(event, settings, answer(null)), {});
  assert.deepEqual(await handleClaudeHook({ ...event, tool_input: { command: "x".repeat(4000) } }, settings,
    { ask: async () => { throw new Error("must not approve truncated details"); } }), {});
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
