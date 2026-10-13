import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "../dist/channels/telegram.js";
import { collectAnswers } from "../dist/questions.js";
import { appendLog } from "./log.mjs";
import { projectEnabled, readSettings, telegramCredentials } from "./settings.mjs";

export async function handleClaudeHook(event, settings, channel) {
  if (!projectEnabled(settings, event.cwd)) return {};
  const label = `[Claude · ${basename(event.cwd)} · ${(event.session_id ?? "").slice(-8)}]`;
  if (event.hook_event_name === "Stop") {
    if (!event.last_assistant_message?.trim()) return {};
    // Replies to any notification of this session, and quick follow-ups, queue for its latest Stop hook.
    const thread = `claude:${event.session_id}`;
    await channel.sendToThread(`${label}\n${event.last_assistant_message}\n\n이 메시지에 답장하면 같은 Claude 세션에서 이어갑니다.`, thread, { forceReply: true });
    const replies = await channel.waitForThread(thread, 86_300);
    if (!replies) return {};
    const text = replies.length === 1 ? replies[0] : replies.map((reply, i) => `${i + 1}. ${reply}`).join("\n\n");
    return { wake: `${label}\n사용자가 텔레그램에서 보낸 다음 작업 지시:\n${text}` };
  }
  if (event.hook_event_name === "PreToolUse" && event.tool_name === "AskUserQuestion") {
    const questions = event.tool_input?.questions;
    if (!Array.isArray(questions) || !questions.length) return {};
    const answers = await collectAnswers(questions, (text, timeout) => channel.ask(`${label}\n${text}`, timeout), 540);
    if (!answers) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...event.tool_input, questions, answers } } };
  }
  if (event.hook_event_name === "PermissionRequest") {
    const details = JSON.stringify(event.tool_input, null, 2);
    // Do not request approval for an action whose details cannot fit in the message.
    if (!details || details.length > 3000) return {};
    const reply = await channel.ask(`${label}\n권한 요청: ${event.tool_name}\n${details}\n\n1. 이번 실행 허용\n2. 거부\n답장으로 1 또는 2를 보내주세요.`, 540);
    if (reply === null) return {};
    const allow = ["1", "허용", "이번 실행 허용"].includes(reply.trim());
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: allow
      ? { behavior: "allow" } : { behavior: "deny", message: "사용자가 Telegram에서 허용하지 않았습니다." } } };
  }
  return {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const settings = await readSettings();
    const { token, chatId } = telegramCredentials(settings);
    // stderr is the wake message, so diagnostics go to a log file.
    const channel = new TelegramChannel(token ?? "", chatId ?? "", (message) => { void appendLog("claude-hook", message); });
    const result = await handleClaudeHook(JSON.parse(input), settings, channel);
    if (result.wake) {
      // asyncRewake delivers this to the existing interactive session, even while idle.
      process.stderr.write(result.wake);
      process.exitCode = 2;
    } else process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Keep Claude's local interaction available if the remote bridge fails.
    await appendLog("claude-hook", `hook failed: ${error?.stack ?? error}`);
    process.stdout.write("{}");
  }
}
