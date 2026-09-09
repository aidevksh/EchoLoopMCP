#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createChannel, DEFAULT_TIMEOUT_SEC, type Channel } from "./channels/index.js";
import { collectAnswers } from "./questions.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function remoteEnabled(): boolean {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".echoloop", "config.json"), "utf8"));
    let path = resolve(process.cwd());
    if (process.platform === "win32") path = path.toLowerCase();
    for (;;) {
      if (Object.hasOwn(settings.projects ?? {}, path)) return settings.projects[path] === true;
      const parent = dirname(path);
      if (parent === path) return false;
      path = parent;
    }
  } catch { return false; }
}

/** Cadence of progress pings that keep the MCP client from timing out a long wait. */
const HEARTBEAT_MS = 20_000;

let channel: Channel | null = null;
let initError: string | null = null;
try {
  channel = createChannel();
  console.error(`echoloop: using ${channel.label}`);
} catch (error) {
  initError = (error as Error).message;
  console.error(`echoloop: ${initError}`);
}

const server = new McpServer({ name: "echoloop", version: "0.1.0" }, {
  instructions: "EchoLoop connects the user through Telegram. Check remote_status to see whether this project is enabled. " +
    "When enabled, use choose for questions requiring the user's selection, " +
    "and ask for free-text clarification, so the user can answer from their phone. " +
    "These tools wait for real user replies. Do not interpret timeout as consent. System permission approvals remain separate.",
});

const failure = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

server.registerTool("remote_status", { description: "Check whether this project's remote Telegram interaction is enabled.", inputSchema: {} },
  async () => ok(JSON.stringify({ enabled: remoteEnabled(), cwd: process.cwd() })));

server.registerTool(
  "notify",
  {
    title: "Notify the user",
    description:
      "Push a message to the user's phone (Telegram or Discord) and return immediately without waiting for an answer. " +
      "Use it when a long task finishes, when a build or test run ends, or to report something the user should see while away from the terminal.",
    inputSchema: {
      message: z.string().min(1).describe("The message to send. Plain text; keep it short enough to read on a phone."),
    },
  },
  async ({ message }) => {
    if (!channel) return failure(initError!);
    try {
      await channel.send(message);
      return ok(`Sent to ${channel.label}.`);
    } catch (error) {
      return failure(`Send failed: ${(error as Error).message}`);
    }
  },
);

server.registerTool(
  "ask",
  {
    title: "Ask the user and wait for a reply",
    description:
      "Push a message to the user's phone and then block until they reply, returning their reply text. " +
      "Use it instead of ending your turn when the user is away from the terminal and you need their next instruction or a decision. " +
      "Treat the returned text as the user's next instruction. Replies sent before this call are ignored. " +
      "On Telegram, use Reply on this question's message to route the answer to this call.",
    inputSchema: {
      message: z
        .string()
        .min(1)
        .describe("What to send. State what you did and what you need from the user, since they answer from a phone."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How long to wait for a reply (default ${DEFAULT_TIMEOUT_SEC}).`),
    },
  },
  async ({ message, timeout_seconds }, extra) => {
    if (!channel) return failure(initError!);
    if (!channel.canReceive) {
      return failure(
        `${channel.label} cannot receive replies. Use "notify" instead, or configure a two-way channel.`,
      );
    }

    const timeoutSec = timeout_seconds ?? DEFAULT_TIMEOUT_SEC;
    const progressToken = extra._meta?.progressToken;
    let heartbeat: NodeJS.Timeout | undefined;

    try {
      if (progressToken !== undefined) {
        const startedAt = Date.now();
        heartbeat = setInterval(() => {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: Math.round((Date.now() - startedAt) / 1000),
                total: timeoutSec,
                message: "Waiting for the user's reply...",
              },
            })
            .catch(() => {});
        }, HEARTBEAT_MS);
      }

      const reply = await channel.ask(message, timeoutSec);
      return reply === null
        ? ok(`No reply within ${timeoutSec}s. The user has not answered yet.`)
        : ok(reply);
    } catch (error) {
      return failure(`Ask failed: ${(error as Error).message}`);
    } finally {
      clearInterval(heartbeat);
    }
  },
);

server.registerTool("choose", {
  title: "Ask the user to choose on Telegram",
  description: "Send questions and numbered options to the user's phone, wait for their reply, and return their selected answers. Use for design and implementation choices rather than a local selection dialog.",
  inputSchema: {
    questions: z.array(z.object({
      question: z.string().min(1).max(1200),
      options: z.array(z.object({ label: z.string().min(1).max(100), description: z.string().max(200).optional() })).min(2).max(8),
      multiSelect: z.boolean().optional(),
    })).min(1).max(4),
    timeout_seconds: z.number().int().positive().max(540).optional(),
  },
}, async ({ questions, timeout_seconds }, extra) => {
  if (!channel?.canReceive) return failure("A two-way channel is required.");
  let progress = 0;
  const heartbeat = extra._meta?.progressToken === undefined ? undefined : setInterval(() => {
    void extra.sendNotification({ method: "notifications/progress", params: {
      progressToken: extra._meta!.progressToken!, progress: ++progress, message: "Waiting for your Telegram selection...",
    } }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    const answers = await collectAnswers(questions, (text, timeout) => channel!.ask(text, timeout), timeout_seconds ?? DEFAULT_TIMEOUT_SEC);
    return answers === null ? failure("No selection received. Do not proceed based on assumed consent.") : ok(JSON.stringify(answers));
  } catch (error) { return failure(`Question failed: ${(error as Error).message}`); }
  finally { clearInterval(heartbeat); }
});

await server.connect(new StdioServerTransport());
