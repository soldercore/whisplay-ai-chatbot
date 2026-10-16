import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { countTransportBytes, createOllamaRequestBudget, OllamaRequestBudget, OllamaResourceLimitError } from "./ollama-resource-limits";

// UTF-8 bytes per record, excluding LF or CRLF. Tool arguments already have
// a 65,536-character execution limit; allow ample room for response metadata.
const MAX_RECORD_BYTES = 1024 * 1024;

// Shared by the normal tool loop and its final no-tools answer. State belongs
// to this response only; callbacks receive newline-terminated records only.
export const readOllamaNDJSON = (
  stream: Readable,
  onRecord: (record: any) => void,
  budget: OllamaRequestBudget = createOllamaRequestBudget(),
): Promise<void> => new Promise((resolve, reject) => {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let recordBytes = 0;
  let endsWithCR = false;
  let sawDone = false;
  let settled = false;
  let responseBytes = 0;

  const cleanup = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.off("close", onClose);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    pending = "";
    recordBytes = 0;
    cleanup();
    stream.destroy();
    reject(error);
  };
  const onData = (chunk: Buffer) => {
    if (settled) return;
    try {
      responseBytes = countTransportBytes(budget, responseBytes, chunk.length);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        recordBytes += end - start;
        if (end > start) endsWithCR = chunk[end - 1] === 0x0d;
        // A trailing CR may be half of CRLF across chunks. Defer at most one
        // byte; if more record data follows, that CR counts as payload too.
        if (recordBytes - (endsWithCR ? 1 : 0) > MAX_RECORD_BYTES) {
          const error = new OllamaResourceLimitError(`Ollama NDJSON record exceeds ${MAX_RECORD_BYTES} UTF-8 bytes`);
          budget.failure = error.message;
          fail(error);
          return;
        }
        pending += decoder.write(chunk.subarray(start, newline === -1 ? end : end + 1));
        if (newline === -1) break;
        const line = pending.trim();
        pending = "";
        recordBytes = 0;
        endsWithCR = false;
        start = end + 1;
        if (!line) continue;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch (error) {
          // Preserve the existing contract: log and skip a malformed complete
          // line. A transport fragment never reaches JSON.parse.
          console.error("Error parsing Ollama NDJSON:", error);
          continue;
        }
        if (typeof record?.error === "string") {
          fail(new Error(`Ollama stream error: ${record.error}`));
          return;
        }
        if (record?.done === true) sawDone = true;
        onRecord(record);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onEnd = () => {
    if (settled) return;
    pending += decoder.end();
    if (pending.trim()) {
      fail(new Error("Truncated Ollama NDJSON record at end of stream"));
      return;
    }
    if (!sawDone) {
      fail(new Error("Ollama stream ended before done=true"));
      return;
    }
    settled = true;
    pending = "";
    cleanup();
    resolve();
  };
  const onError = (error: Error) => fail(pending.trim()
    ? new Error(`Truncated Ollama NDJSON record after stream error: ${error.message}`)
    : error);
  const onClose = () => fail(new Error("Ollama stream closed before end (truncated response)"));
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onError);
  stream.on("close", onClose);
});
