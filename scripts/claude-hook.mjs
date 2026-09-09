import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "../dist/channels/telegram.js";
import { collectAnswers } from "../dist/questions.js";
import { projectEnabled, readSettings, telegramCredentials } from "./settings.mjs";

export async function handleClaudeHook(event, settings, ask) {
  if (!projectEnabled(settings, event.cwd)) return {};
  const label = `[Claude · ${basename(event.cwd)} · ${(event.session_id ?? "").slice(-8)}]`;
  if (event.hook_event_name === "Stop") {
    if (!event.last_assistant_message?.trim()) return {};
    const reply = await ask(`${label}\n${event.last_assistant_message}\n\n이 메시지에 답장하면 같은 Claude 세션에서 이어갑니다.`, 86_300);
    return reply === null ? {} : { wake: `${label}\n사용자가 텔레그램에서 보낸 다음 작업 지시:\n${reply}` };
  }
  if (event.hook_event_name === "PreToolUse" && event.tool_name === "AskUserQuestion") {
    const questions = event.tool_input?.questions;
    if (!Array.isArray(questions) || !questions.length) return {};
    const answers = await collectAnswers(questions, (text, timeout) => ask(`${label}\n${text}`, timeout), 540);
    if (!answers) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...event.tool_input, questions, answers } } };
  }
  if (event.hook_event_name === "PermissionRequest") {
    const details = JSON.stringify(event.tool_input, null, 2);
    // Do not request approval for an action whose details cannot fit in the message.
    if (!details || details.length > 3000) return {};
    const reply = await ask(`${label}\n권한 요청: ${event.tool_name}\n${details}\n\n1. 이번 실행 허용\n2. 거부\n답장으로 1 또는 2를 보내주세요.`, 540);
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
    const channel = new TelegramChannel(token ?? "", chatId ?? "");
    const result = await handleClaudeHook(JSON.parse(input), settings, (text, timeout) => channel.ask(text, timeout));
    if (result.wake) {
      // asyncRewake delivers this to the existing interactive session, even while idle.
      process.stderr.write(result.wake);
      process.exitCode = 2;
    } else process.stdout.write(JSON.stringify(result));
  } catch {
    // Keep Claude's local interaction available if the remote bridge fails.
    process.stdout.write("{}");
  }
}
