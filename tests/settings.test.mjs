import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "smol-toml";
import { projectEnabled, projectKey } from "../scripts/settings.mjs";
import { replaceNotify } from "../scripts/echoloop.mjs";

test("projects inherit the nearest setting without enabling sibling folders", () => {
  const root = join(tmpdir(), "project-a");
  const settings = { projects: { [projectKey(root)]: true, [projectKey(join(root, "private"))]: false } };
  assert.equal(projectEnabled(settings, join(root, "src")), true);
  assert.equal(projectEnabled(settings, join(root, "private", "src")), false);
  assert.equal(projectEnabled(settings, `${root}-other`), false);
});

test("hook installation preserves unrelated TOML and replaces multiline arrays containing brackets", () => {
  const source = '# preferences\nnotify = [\n "C:/some[path]/node",\n "old.js",\n]\nmodel = "existing"\n[desktop]\nfoo = true\n';
  const replaced = replaceNotify(source, ["node", "new.js"]);
  assert.deepEqual(parse(replaced).notify, ["node", "new.js"]);
  assert.ok(replaced.startsWith("# preferences\n"));
  assert.ok(replaced.endsWith('model = "existing"\n[desktop]\nfoo = true\n'));
  assert.deepEqual(parse(replaceNotify("[desktop]\nfoo = true\n", ["node"])).notify, ["node"]);
});

test("CLI toggles persist per project and status never prints the token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "echoloop-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".echoloop"));
  await writeFile(join(home, ".echoloop", "config.json"), JSON.stringify({ telegram: { token: "123:secret", chatId: "456" }, projects: {} }));
  const run = (args) => promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../scripts/echoloop.mjs", import.meta.url)), ...args],
    { env: { ...process.env, HOME: home, USERPROFILE: home } });
  const project = join(home, "another-project");
  await run(["on", project]);
  assert.equal(projectEnabled(JSON.parse(await readFile(join(home, ".echoloop", "config.json"), "utf8")), project), true);
  const { stdout } = await run(["status", project]);
  assert.match(stdout, /ON/);
  assert.ok(!stdout.includes("secret"));
  assert.match((await run(["help"])).stdout, /Enable notifications/);
  await run(["language", "ko"]);
  assert.match((await run(["help"])).stdout, /프로젝트 알림 켜기/);
  assert.match((await run(["status"])).stdout, /연결됨/);
  await assert.rejects(run(["unknown"]), /echoloop help/);
  await assert.rejects(run(["language", "fr"]), /echoloop help/);
  await run(["off", project]);
  assert.equal(projectEnabled(JSON.parse(await readFile(join(home, ".echoloop", "config.json"), "utf8")), project), false);
});

test("setup exits on EOF or malformed token without saving credentials", async (t) => {
  for (const input of ["", "1\ninvalid-token\n"]) {
    const home = await mkdtemp(join(tmpdir(), "echoloop-input-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const result = await new Promise((resolve) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL("../scripts/echoloop.mjs", import.meta.url)), "setup"],
        { timeout: 5000, env: { ...process.env, HOME: home, USERPROFILE: home, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      child.stdin.end(input);
    });
    assert.equal(result.error.code, 1);
    assert.match(result.stderr, input ? /Invalid bot token/ : /Input ended/);
    if (input) {
      const saved = JSON.parse(await readFile(join(home, ".echoloop", "config.json"), "utf8"));
      assert.equal(saved.language, "en");
      assert.equal(saved.telegram, undefined);
    }
  }
});

for (const [choice, language] of [["1", "en"], ["2", "ko"]]) {
test(`first setup (${language}) saves a discovered chat and installs the hook without exposing the token`, { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "echoloop-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDirectory = join(home, ".codex");
  await mkdir(configDirectory);
  await writeFile(join(configDirectory, "config.toml"), '# keep me\nnotify = ["old-command", "old-arg"]\nmodel = "unchanged"\n');
  const child = fork(new URL("./fixtures/setup-client.mjs", import.meta.url), {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: configDirectory,
      TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let error = "";
  let paired = false;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    const code = output.match(/\?start=(echoloop_[a-f0-9]+)/)?.[1];
    if (code && !paired) { paired = true; child.send({ code }); }
  });
  child.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(`${choice}\n123:secret-setup-token\n`);
  assert.equal(await done, 0, error);
  const saved = JSON.parse(await readFile(join(home, ".echoloop", "config.json"), "utf8"));
  assert.equal(saved.language, language);
  assert.deepEqual(saved.telegram, { token: "123:secret-setup-token", chatId: "987" });
  assert.equal(projectEnabled(saved, home), true);
  assert.ok(!output.includes("secret-setup-token"));
  assert.match(output, language === "ko" ? /연결됨/ : /Connected/);
  const configured = await readFile(join(configDirectory, "config.toml"), "utf8");
  assert.equal(parse(configured).model, "unchanged");
  assert.ok(configured.includes("# keep me"));
  assert.match(parse(configured).notify[1], /codex-notify\.mjs$/);
  assert.deepEqual(JSON.parse(await readFile(join(home, ".echoloop", "codex-notify", "original.json"), "utf8")), ["old-command", "old-arg"]);
});
}
