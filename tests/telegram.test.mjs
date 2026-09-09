import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

async function harness(t, handle) {
  const home = await mkdtemp(join(tmpdir(), "echoloop-test-"));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map((child) => new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    })));
    await rm(home, { recursive: true, force: true });
  });
  return () => {
    const child = fork(new URL("./fixtures/telegram-client.mjs", import.meta.url), {
      env: { ...process.env, HOME: home, USERPROFILE: home, TEST_TOKEN: "123:test-bot" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    child.on("message", async (message) => {
      if (message.type !== "request") return;
      const body = await handle(message);
      if (child.connected) child.send({ type: "response", id: message.id, body });
    });
    return (text, timeout) => new Promise((resolve) => {
      const listener = (message) => {
        if (message.type !== "result") return;
        child.off("message", listener);
        resolve(message);
      };
      child.on("message", listener);
      child.send(typeof text === "object" ? text : { type: "ask", text, timeout });
    });
  };
}

const update = (id, target, text, chat = 123) => ({
  update_id: id,
  message: { text, chat: { id: chat }, ...(target ? { reply_to_message: { message_id: target } } : {}) },
});

test("setup discovers only the private chat using the current pairing code", { timeout: 15000 }, async (t) => {
  const client = await harness(t, async () => ({ ok: true, result: [
    { update_id: 1, message: { text: "/start", chat: { id: 1, type: "private" } } },
    { update_id: 2, message: { text: "/start old-code", chat: { id: 2, type: "private" } } },
    { update_id: 3, message: { text: "/start new-code", chat: { id: 3, type: "group" } } },
    { update_id: 4, message: { text: "/start new-code", chat: { id: 456, type: "private" } } },
  ] }));
  assert.deepEqual(await client()({ type: "discoverChat", code: "new-code" }), { type: "result", reply: "456" });
});

test("replies to previous notifications route only when the original author is our bot", { timeout: 15000 }, async (t) => {
  const client = await harness(t, async () => ({ ok: true, result: [
    { update_id: 1, message: { text: "spoof", chat: { id: 123 },
      reply_to_message: { message_id: 77, text: "previous notification", from: { id: 999 } } } },
    { update_id: 2, message: { text: "do the next task", chat: { id: 123 },
      reply_to_message: { message_id: 78, text: "previous notification", from: { id: 123 } } } },
  ] }));
  const call = client();
  await call({ type: "registerPreviousNotifications", texts: ["previous notification"], threadId: "original-thread" });
  assert.deepEqual((await call({ type: "receiveThreadReplies" })).reply,
    [{ updateId: 2, threadId: "original-thread", text: "do the next task" }]);
});

test("notification replies survive another process polling, retain routing, and are acknowledged once", { timeout: 15000 }, async (t) => {
  let messageId = 10;
  let updates = [];
  const client = await harness(t, async ({ method, params }) => {
    if (method === "sendMessage") {
      const id = messageId++;
      if (params.text === "Question") updates.push(update(4, id, "ask answer"));
      return { ok: true, result: { message_id: id } };
    }
    return { ok: true, result: updates.filter((item) => item.update_id >= params.offset) };
  });
  const notifier = client();
  const receiver = client();
  await notifier({ type: "sendToThread", text: "A complete", threadId: "thread-A" });
  await notifier({ type: "sendToThread", text: "B complete", threadId: "thread-B" });
  updates = [update(1, 11, "next B"), update(2, 10, "next A"), update(3, 10, "wrong chat", 999)];
  assert.deepEqual(await notifier("Question"), { type: "result", reply: "ask answer" });
  const expected = [
    { updateId: 1, threadId: "thread-B", text: "next B" },
    { updateId: 2, threadId: "thread-A", text: "next A" },
  ];
  assert.deepEqual((await notifier({ type: "receiveThreadReplies" })).reply, expected);
  assert.deepEqual((await receiver({ type: "receiveThreadReplies" })).reply, expected);
  await receiver({ type: "acknowledgeThreadReply", updateId: 1 });
  assert.deepEqual((await notifier({ type: "receiveThreadReplies" })).reply, [expected[1]]);
  await receiver({ type: "acknowledgeThreadReply", updateId: 2 });
  assert.deepEqual((await receiver({ type: "receiveThreadReplies" })).reply, []);
});

test("separate processes route a batch of reverse-order replies without stealing or overlapping polls", { timeout: 15000 }, async (t) => {
  const sent = new Map();
  let activePolls = 0;
  let maxPolls = 0;
  const client = await harness(t, async ({ method, params }) => {
    if (method === "sendMessage") {
      assert.equal(params.reply_markup.force_reply, true);
      sent.set(params.text, sent.size + 100);
      return { ok: true, result: { message_id: sent.get(params.text) } };
    }
    maxPolls = Math.max(maxPolls, ++activePolls);
    await sleep(30);
    const result = sent.size < 2 ? [] : [
      update(1, null, "unaddressed"),
      update(2, sent.get("A"), "wrong chat", 999),
      update(3, 9999, "old question"),
      update(4, sent.get("B"), "answer B"),
      update(5, sent.get("A"), "answer A"),
      update(6, sent.get("A"), "duplicate answer"),
    ].filter((item) => item.update_id >= params.offset);
    activePolls--;
    return { ok: true, result };
  });
  const a = client();
  const b = client();
  assert.deepEqual(await Promise.all([a("A"), b("B")]), [
    { type: "result", reply: "answer A" },
    { type: "result", reply: "answer B" },
  ]);
  assert.equal(maxPolls, 1);
});

test("plain text and replies to expired questions do not satisfy a later ask", { timeout: 15000 }, async (t) => {
  let sent = 0;
  const client = await harness(t, async ({ method, params }) => {
    if (method === "sendMessage") return { ok: true, result: { message_id: ++sent } };
    await sleep(20);
    return { ok: true, result: [update(1, null, "plain text"),
      ...(sent > 1 ? [update(2, 1, "late reply to first question")] : [])]
      .filter((item) => item.update_id >= params.offset) };
  });
  const ask = client();
  assert.deepEqual(await ask("first", 1), { type: "result", reply: null });
  assert.deepEqual(await ask("second", 1), { type: "result", reply: null });
});

test("a failed send releases the shared lock for another ask", { timeout: 15000 }, async (t) => {
  let sends = 0;
  const client = await harness(t, async ({ method }) => {
    if (method === "sendMessage") {
      return ++sends === 1 ? { ok: false, description: "test failure" }
        : { ok: true, result: { message_id: 42 } };
    }
    return { ok: true, result: [update(1, 42, "recovered")] };
  });
  const ask = client();
  assert.match((await ask("fails")).error, /test failure/);
  assert.deepEqual(await ask("works"), { type: "result", reply: "recovered" });
});
