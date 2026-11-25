import type { ConversationHistory } from "./store";

/**
 * Turns a stored transcript (`chat_load_conversation_v1`) into what the chat panel renders (T-203).
 * Pure: the answer objects are the ones the store already validated against the `Answer` contract,
 * and a withheld run keeps the stored text but carries no answer, so no evidence is shown for it.
 */
export type TranscriptTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: NonNullable<NonNullable<ConversationHistory["messages"][number]["run"]>["answer"]> | null; progress: []; withheldText?: string };

export function transcriptTurns(history: ConversationHistory): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of [...history.messages].sort((a, b) => a.seq - b.seq)) {
    if (message.role === "user") {
      turns.push({ role: "user", text: message.bodyText });
      continue;
    }
    const run = message.run;
    if (run !== null && run.withheld) {
      turns.push({ role: "assistant", answer: null, progress: [], withheldText: message.bodyText });
    } else if (run !== null && run.answer !== null) {
      turns.push({ role: "assistant", answer: run.answer, progress: [] });
    } else {
      // A run still in flight (or a message with no run): show the stored text, never a candidate.
      turns.push({ role: "assistant", answer: null, progress: [], withheldText: message.bodyText });
    }
  }
  return turns;
}
