export interface Question {
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export function formatQuestion(question: Question): string {
  return [question.question, ...question.options.map((option, i) =>
    `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
  question.multiSelect ? "답장으로 번호를 쉼표로 구분하거나 원하는 내용을 적어주세요." : "답장으로 번호 또는 원하는 내용을 적어주세요."].join("\n\n");
}

export function parseAnswer(question: Question, reply: string): string | null {
  const answer = reply.trim();
  if (!answer) return null;
  if (!/^[\d\s,]+$/.test(answer)) return answer;
  const indexes = answer.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!indexes.length || (!question.multiSelect && indexes.length !== 1) || indexes.some((i) => i < 1 || i > question.options.length)) return null;
  return [...new Set(indexes)].map((i) => question.options[i - 1].label).join(", ");
}

export async function collectAnswers(
  questions: Question[],
  ask: (text: string, timeoutSec: number) => Promise<string | null>,
  timeoutSec: number,
): Promise<Record<string, string> | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  const answers: Record<string, string> = {};
  for (const question of questions) {
    let retry = "";
    for (;;) {
      const remaining = Math.floor((deadline - Date.now()) / 1000);
      if (remaining <= 0) return null;
      const reply = await ask(retry + formatQuestion(question), remaining);
      if (reply === null) return null;
      const answer = parseAnswer(question, reply);
      if (answer !== null) { answers[question.question] = answer; break; }
      retry = "선택 번호를 확인해주세요.\n\n";
    }
  }
  return answers;
}
