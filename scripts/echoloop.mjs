#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { TelegramChannel } from "../dist/channels/telegram.js";
import { projectEnabled, projectKey, readSettings, settingsDirectory, updateSettings } from "./settings.mjs";

import { languageOf, messages } from "./language.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function replaceNotify(source, command) {
  const parsed = parse(source);
  const line = `notify = ${JSON.stringify(command)}`;
  if (!Object.hasOwn(parsed, "notify")) return `${line}\n${source}`;
  const match = /^notify\s*=\s*/m.exec(source);
  if (!match) throw new Error("Cannot locate the existing notify setting.");
  const start = match.index + match[0].length;
  for (let end = source.indexOf("]", start); end !== -1; end = source.indexOf("]", end + 1)) {
    try {
      if (!Array.isArray(parse(`notify = ${source.slice(start, end + 1)}`).notify)) continue;
    } catch { continue; }
    return source.slice(0, match.index) + line + source.slice(end + 1);
  }
  throw new Error("Cannot parse the existing notify command.");
}

async function installHook(text) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  let candidates;
  try { candidates = execFileSync(locator, ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/); }
  catch { return false; }
  const codexDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = join(codexDirectory, "config.toml");
  let source = "";
  try { source = await readFile(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const original = parse(source).notify ?? [];
  const wrapper = join(root, "scripts", "codex-notify.mjs");
  const isOurHook = original.some((arg) => typeof arg === "string" && arg.replaceAll("\\", "/").endsWith("/scripts/codex-notify.mjs"));
  const notifyDirectory = join(settingsDirectory, "codex-notify");
  await mkdir(notifyDirectory, { recursive: true });
  if (!isOurHook) await writeFile(join(notifyDirectory, "original.json"), JSON.stringify(original));
  let codex = candidates.find((path) => path.endsWith(".exe")) ?? candidates[0];
  let codexArgs = [];
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(codex)) {
    const entry = join(dirname(codex), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(entry)) throw new Error(text.codexEntry);
    codex = process.execPath;
    codexArgs = [entry];
  }
  execFileSync(codex, [...codexArgs, "queue", "--help"], { stdio: "ignore", windowsHide: true });
  await mkdir(join(settingsDirectory, "codex-replies"), { recursive: true });
  await writeFile(join(settingsDirectory, "codex-replies", "settings.json"), JSON.stringify({ codex, codexArgs }));
  await mkdir(codexDirectory, { recursive: true });
  let configured = replaceNotify(source, [process.execPath, wrapper]);
  if (!parse(source).mcp_servers?.echoloop) {
    configured += `\n[mcp_servers.echoloop]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(root, "dist", "index.js")])}\ntool_timeout_sec = 600\n`;
  }
  await writeFile(path, configured);
  return true;
}

export function mergeClaudeHooks(settings, nodePath, scriptPath) {
  const result = structuredClone(settings);
  result.hooks ??= {};
  for (const [event, matcher, extra] of [
    ["Stop", undefined, { asyncRewake: true, timeout: 86400 }],
    ["PreToolUse", "AskUserQuestion", { timeout: 600 }],
    ["PermissionRequest", undefined, { timeout: 600 }],
  ]) {
    const entries = result.hooks[event] ?? [];
    // Replace only our hook, preserving other matchers and commands.
    result.hooks[event] = entries.map((entry) => ({ ...entry, hooks: entry.hooks.filter((hook) =>
      !(hook.args ?? []).some((arg) => typeof arg === "string" && arg.replaceAll("\\", "/").endsWith("/scripts/claude-hook.mjs"))) }))
      .filter((entry) => entry.hooks.length);
    result.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [
      { type: "command", command: nodePath, args: [scriptPath], ...extra },
    ] });
  }
  return result;
}

async function installClaudeHook() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try { execFileSync(locator, ["claude"], { stdio: "ignore" }); }
  catch { return false; }
  const directory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const path = join(directory, "settings.json");
  let settings = {};
  try { settings = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify(mergeClaudeHooks(settings, process.execPath, join(root, "scripts", "claude-hook.mjs")), null, 2));
  return true;
}

async function installIntegrations(text) {
  const codex = await installHook(text);
  const claude = await installClaudeHook();
  if (!codex && !claude) throw new Error(text.clients);
  return [codex && "Codex", claude && "Claude Code"].filter(Boolean).join(", ");
}

function prompts() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const input = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const lines = input[Symbol.asyncIterator]();
  return {
    async read(prompt, text, secret = false) {
      muted = secret;
      process.stdout.write(prompt);
      const result = await lines.next();
      muted = false;
      if (secret) process.stdout.write("\n");
      if (result.done) throw new Error(text.eof);
      return result.value.trim();
    },
    close() { input.close(); },
  };
}

async function setup() {
  let settings = await readSettings();
  let input;
  const read = (...args) => (input ??= prompts()).read(...args);
  try {
    if (!['en', 'ko'].includes(settings.language)) {
      let language;
      while (!language) {
        const answer = (await read('Language / 출력 언어: 1. English  2. 한국어 [1/2]: ', messages.en)).toLowerCase();
        language = ({ '1': 'en', en: 'en', english: 'en', '2': 'ko', ko: 'ko', korean: 'ko', '한국어': 'ko' })[answer];
      }
      settings = await updateSettings((value) => { value.language = language; });
    }
    const text = messages[languageOf(settings)];
    if (!settings.telegram) {
      console.log(text.bot);
      const token = process.env.TELEGRAM_BOT_TOKEN || await read(text.token, text, true);
      if (!/^\d+:[\w-]+$/.test(token)) throw new Error(text.invalidToken);
      const channel = new TelegramChannel(token, "");
      const username = await channel.botUsername();
      let chatId = process.env.TELEGRAM_BOT_TOKEN === token ? process.env.TELEGRAM_CHAT_ID : undefined;
      if (!chatId) {
        const code = `echoloop_${randomBytes(16).toString("hex")}`;
        console.log(`${text.pair}\nhttps://t.me/${username}?start=${code}`);
        chatId = await channel.discoverChat(code);
        if (!chatId) throw new Error(text.timeout);
      }
      settings = await updateSettings((value) => { value.telegram = { token, chatId }; });
    }
    const clients = await installIntegrations(text);
    await updateSettings((value) => { (value.projects ??= {})[projectKey(process.cwd())] = true; });
    console.log(`${text.connected}: Telegram (chat ${settings.telegram.chatId})\nON: ${process.cwd()}\n${clients}\n${text.restart}\n\n${text.help}`);
  } finally { input?.close(); }
}

export async function main(args) {
  const settings = await readSettings();
  const text = messages[languageOf(settings)];
  const [command = "help", path = process.cwd(), ...extra] = args;
  if (extra.length || (["setup", "help", "--help", "-h"].includes(command) && args.length > 1)) throw new Error(text.usage);
  if (["help", "--help", "-h"].includes(command)) { console.log(text.help); return; }
  if (command === "language") {
    if (!['en', 'ko'].includes(args[1])) throw new Error(text.usage);
    await updateSettings((value) => { value.language = args[1]; });
    console.log(messages[args[1]].language);
    return;
  }
  if (command === "setup") return setup();
  if (command === "on" || command === "off") {
    if (command === "on" && !settings.telegram) throw new Error(text.first);
    await updateSettings((value) => { (value.projects ??= {})[projectKey(path)] = command === "on"; });
    console.log(`${command.toUpperCase()}: ${resolve(path)}`);
    return;
  }
  if (command === "status") {
    console.log(`Telegram: ${settings.telegram ? `${text.connected} (chat ${settings.telegram.chatId})` : text.missing}`);
    console.log(`${text.project}: ${projectEnabled(settings, path) ? "ON" : "OFF"} — ${resolve(path)}`);
    for (const [project, enabled] of Object.entries(settings.projects ?? {})) console.log(`  ${enabled ? "ON " : "OFF"} ${project}`);
    return;
  }
  throw new Error(text.usage);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
