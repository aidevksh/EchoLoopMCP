import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { notificationText, readSessionMetadata } from "../scripts/codex-notify.mjs";
import { projectKey } from "../scripts/settings.mjs";

const event = { type: "agent-turn-complete", cwd: fileURLToPath(new URL("..", import.meta.url)),
  "thread-id": "thread-12345678", "last-assistant-message": "완료했습니다." };
const session = { id: event["thread-id"], source: "vscode", thread_source: "user" };
const settings = { projects: { [projectKey(event.cwd)]: true } };

test("automatic notification includes only this project's completed answer", () => {
  assert.equal(notificationText(event, settings, session), `[${basename(event.cwd)} · 12345678]\n완료했습니다.`);
  assert.equal(notificationText({ ...event, type: "other" }, settings, session), null);
  assert.equal(notificationText({ ...event, cwd: fileURLToPath(new URL("../..", import.meta.url)) }, settings, session), null);
  assert.equal(notificationText({ ...event, "last-assistant-message": "" }, settings, session), null);
  assert.equal(notificationText(event, { projects: {} }, session), null);
});

test("subagent completion reports never notify before the user's final answer", () => {
  for (const source of ["subagent", { subagent: "review" }, { internal: "memory_consolidation" },
    { subagent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } }]) {
    assert.equal(notificationText(event, settings, { ...session, source, thread_source: undefined }), null);
  }
  for (const thread_source of ["subagent", "guardian_review", "memory_consolidation"]) {
    assert.equal(notificationText(event, settings, { ...session, thread_source }), null);
  }
});

test("unverified internal sessions cannot send automatic notifications", () => {
  assert.equal(notificationText(event, settings), null);
  assert.equal(notificationText(event, settings, { ...session, id: "another-thread" }), null);
});

test("older user sessions still notify without thread_source", () => {
  for (const source of ["cli", "vscode", "exec", "mcp"]) {
    assert.ok(notificationText(event, settings, { id: session.id, source }));
  }
});

test("session lookup reads only matching metadata in the configured Codex home", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "echoloop-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "sessions", "2026", "10", "15");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-timestamp-${session.id}.jsonl`);
  const metadata = { ...session, base_instructions: { text: "x".repeat(128 * 1024) } };
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: metadata })}\ninvalid later record\n`);
  assert.deepEqual(await readSessionMetadata(session.id, home), metadata);
  assert.equal(await readSessionMetadata("missing-thread", home), null);
  assert.equal(await readSessionMetadata(undefined, home), null);
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { ...session, id: "other-thread" } }) + "\n");
  assert.equal(await readSessionMetadata(session.id, home), null);
});

test("archived user sessions remain eligible for delayed completion hooks", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "echoloop-codex-archive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "archived_sessions");
  await mkdir(directory);
  await writeFile(join(directory, `rollout-timestamp-${session.id}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: session }) + "\n");
  assert.deepEqual(await readSessionMetadata(session.id, home), session);
});

test("forward skips non-user completions and sends the parent's final answer only once", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "echoloop-codex-forward-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".echoloop"));
  await writeFile(join(home, ".echoloop", "config.json"),
    JSON.stringify({ ...settings, telegram: { token: "123:test-token", chatId: "456" } }));
  const codexHome = join(home, "custom-codex");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await writeFile(join(codexHome, "sessions", `rollout-timestamp-${session.id}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { ...session, thread_source: "subagent" } }) + "\n");
  const parentEvent = { ...event, "thread-id": "parent-thread", "turn-id": "turn-1" };
  await writeFile(join(codexHome, "sessions", "rollout-timestamp-parent-thread.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { ...session, id: "parent-thread" } }) + "\n");
  const script = `import { forward } from ${JSON.stringify(new URL("../scripts/codex-notify.mjs", import.meta.url).href)};
    import assert from "node:assert/strict";
    import { mkdir, readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    globalThis.fetch = () => { throw new Error("must not send"); };
    await forward(${JSON.stringify(event)});
    await forward(${JSON.stringify({ ...event, "thread-id": "internal-title-thread" })});
    const receiver = join(process.env.USERPROFILE, ".echoloop", "codex-replies");
    await mkdir(receiver);
    await writeFile(join(receiver, "status.json"), JSON.stringify({ pid: process.pid }));
    const sent = [];
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith("/sendMessage"));
      sent.push(JSON.parse(options.body));
      return { json: async () => ({ ok: true, result: { message_id: 42 } }) };
    };
    await forward(${JSON.stringify(parentEvent)});
    await forward(${JSON.stringify(parentEvent)});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, ${JSON.stringify(`[${basename(event.cwd)} · t-thread]\n완료했습니다.`)});
    const lastSent = JSON.parse(await readFile(join(process.env.USERPROFILE, ".echoloop", "codex-notify", "last-sent.json"), "utf8"));
    assert.equal(lastSent.threadId, "parent-thread");
    assert.equal(lastSent.turnId, "turn-1");`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome } });
});
