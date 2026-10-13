import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { settingsDirectory } from "./settings.mjs";

const MAX_BYTES = 1_000_000;

/** Append a diagnostic line to ~/.echoloop/logs/<name>.log. Logging never throws. */
export async function appendLog(name, message) {
  try {
    const directory = join(settingsDirectory, "logs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.log`);
    if ((await stat(path).catch(() => null))?.size > MAX_BYTES) await rename(path, `${path}.1`);
    await appendFile(path, `${new Date().toISOString()} [${process.pid}] ${message}\n`, { mode: 0o600 });
  } catch { /* A diagnostic log must not break the caller. */ }
}
