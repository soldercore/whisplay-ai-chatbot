import type { OllamaMessage } from "../../type";

// Injected context precedes its owning user message. Unmarked system messages
// may share that block, but remain permanent and are protected separately.
export function ollamaTurnStart(messages: { role: string }[], userIndex: number): number {
  let start = userIndex;
  while (start > 1 && messages[start - 1].role === "system") start--;
  return start;
}

// Safety ceilings in addition to normal token-based compaction. Keep complete
// recent user turns; never retain a tool result after dropping its proposal.
export function boundOllamaHistory(messages: OllamaMessage[]): boolean {
  const exceeds = () => messages.length > 200 || Buffer.byteLength(JSON.stringify(messages), "utf8") > 4 * 1024 * 1024;
  while (exceeds()) {
    const firstUser = messages.findIndex(message => message.role === "user");
    const nextUser = messages.findIndex((message, index) => index > Math.max(1, firstUser) && message.role === "user");
    const end = nextUser > 1 ? ollamaTurnStart(messages, nextUser) : messages.length;
    const permanent = messages.slice(1, end).filter(message => message.role === "system" && message.contextScope !== "turn");
    if (nextUser > 1) messages.splice(1, end - 1, ...permanent);
    else {
      messages.splice(1, messages.length - 1, ...permanent);
      messages.push({ role: "system", content: "[Oversized conversation turn omitted. Completion of any attempted action was not verified.]" });
      return true;
    }
  }
  return false;
}
