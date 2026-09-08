#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createChannel, DEFAULT_TIMEOUT_SEC, type Channel } from "./channels/index.js";

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

const server = new McpServer({ name: "echoloop", version: "0.1.0" });

const failure = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

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

await server.connect(new StdioServerTransport());
