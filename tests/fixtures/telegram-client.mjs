import { TelegramChannel } from "../../dist/channels/telegram.js";

let nextId = 0;
const requests = new Map();
globalThis.fetch = async (url, options) => {
  const id = ++nextId;
  const response = new Promise((resolve) => requests.set(id, resolve));
  process.send({ type: "request", id, method: url.split("/").pop(), params: JSON.parse(options.body) });
  // A response of { throw } stands for a network failure such as "fetch failed".
  const body = await response;
  if (body.throw) throw new TypeError(body.throw);
  return { json: async () => body };
};

const channel = new TelegramChannel(process.env.TEST_TOKEN, "123");
process.on("message", async (message) => {
  if (message.type === "response") {
    requests.get(message.id)(message.body);
    requests.delete(message.id);
  } else {
    try {
      let reply;
      if (message.type === "ask") reply = await channel.ask(message.text, message.timeout ?? 5);
      if (message.type === "sendToThread") await channel.sendToThread(message.text, message.threadId, message.options);
      if (message.type === "waitForThread") reply = await channel.waitForThread(message.threadId, message.timeout ?? 5);
      if (message.type === "registerPreviousNotifications") await channel.registerPreviousNotifications(message.texts, message.threadId);
      if (message.type === "discoverChat") reply = await channel.discoverChat(message.code, message.timeout ?? 5);
      if (message.type === "receiveThreadReplies") reply = await channel.receiveThreadReplies();
      if (message.type === "acknowledgeThreadReply") await channel.acknowledgeThreadReply(message.updateId);
      process.send({ type: "result", reply });
    } catch (error) {
      process.send({ type: "result", error: error.message });
    }
  }
});
