import type { OllamaMessage } from "../../type";

// Safety ceilings in addition to normal token-based compaction. Keep complete
// recent user turns; never retain a tool result after dropping its proposal.
export function boundOllamaHistory(messages: OllamaMessage[]): boolean {
  const exceeds = () => messages.length > 200 || Buffer.byteLength(JSON.stringify(messages), "utf8") > 4 * 1024 * 1024;
  while (exceeds()) {
    const nextUser = messages.findIndex((message, index) => index > 1 && message.role === "user");
    if (nextUser > 1) messages.splice(1, nextUser - 1);
    else {
      messages.splice(1);
      messages.push({ role: "system", content: "[Oversized conversation turn omitted. Completion of any attempted action was not verified.]" });
      return true;
    }
  }
  return false;
}
