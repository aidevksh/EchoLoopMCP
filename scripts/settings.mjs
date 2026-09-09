import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export const settingsDirectory = join(homedir(), ".echoloop");
export const settingsPath = join(settingsDirectory, "config.json");

export function projectKey(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function readSettings() {
  try { return JSON.parse(await readFile(settingsPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { projects: {} };
  }
}

export async function updateSettings(change) {
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(settingsDirectory, { realpath: false, retries: 10 });
  try {
    const settings = await readSettings();
    change(settings);
    await writeFile(`${settingsPath}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(`${settingsPath}.tmp`, settingsPath);
    return settings;
  } finally { await release(); }
}

export function projectEnabled(settings, cwd) {
  if (!cwd) return false;
  let path = projectKey(cwd);
  for (;;) {
    if (Object.hasOwn(settings.projects ?? {}, path)) return settings.projects[path];
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

export function telegramCredentials(settings) {
  return settings.telegram ?? {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };
}
