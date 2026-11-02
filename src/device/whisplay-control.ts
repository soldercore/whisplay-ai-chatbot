import net from "node:net";
import { currentToolSignal, checkCancelled, operationDeadline } from "../utils/operation-lifecycle";

const socketPath = () => process.env.WHISPLAY_CONTROL_SOCKET || "/tmp/whisplay-daemon.sock";

export async function whisplayRequest(command: string, payload: object, parent: AbortSignal | null | undefined = currentToolSignal()): Promise<any> {
  checkCancelled(parent || undefined);
  const deadline = operationDeadline(30_000, parent || undefined);
  try {
    return await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath());
      let bytes = Buffer.alloc(0), settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", abort);
        client.destroy();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error("Whisplay request cancelled; a sent action may already have completed"));
      deadline.signal.addEventListener("abort", abort, { once: true });
      client.once("connect", () => {
        if (deadline.signal.aborted) { abort(); return; }
        client.write(JSON.stringify({ version: 1, cmd: command, payload }) + "\n");
      });
      client.on("data", chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 65536) { finish(new Error("Whisplay response exceeds bound")); return; }
        const end = bytes.indexOf(10);
        if (end < 0) return;
        try {
          const response = JSON.parse(bytes.subarray(0, end).toString("utf8"));
          if (response.ok !== true) throw new Error(String(response.error || "Whisplay operation rejected"));
          finish(undefined, response.payload);
        } catch (error) { finish(error as Error); }
      });
      client.once("error", error => finish(error));
      client.once("close", () => { if (!settled) finish(new Error("Whisplay connection ended without a result")); });
      if (deadline.signal.aborted) abort();
    });
  } finally { deadline.dispose(); }
}

const tickets = new Map<string, { signal?: AbortSignal; cancel: () => void }>();
export function trackWhisplayHandoff(ticket: string, signal = currentToolSignal()): void {
  const cancel = () => {
    tickets.delete(ticket);
    void whisplayRequest("control.cancel", { ticket }, null).catch(() => {});
  };
  if (signal?.aborted) { cancel(); return; }
  tickets.set(ticket, { signal, cancel });
  signal?.addEventListener("abort", cancel, { once: true });
  // Bounded local ownership; the daemon independently expires its ticket.
  const timer = setTimeout(() => cancelWhisplayHandoff(ticket), 120_000);
  timer.unref();
}
export function cancelWhisplayHandoff(ticket: string): void {
  const entry = tickets.get(ticket);
  if (!entry) return;
  entry.signal?.removeEventListener("abort", entry.cancel);
  entry.cancel();
}
export async function presentWhisplayHandoff(ticket: string): Promise<void> {
  const entry = tickets.get(ticket);
  if (!entry || entry.signal?.aborted) throw new Error("Whisplay handoff no longer belongs to this answer");
  entry.signal?.removeEventListener("abort", entry.cancel);
  tickets.delete(ticket);
  await whisplayRequest("control.present", { ticket }, null);
}

export function whisplayHandoffTicket(result?: string): string | undefined {
  if (!result?.startsWith("[success]")) return;
  try {
    const value = JSON.parse(result.slice(9));
    return /^(awaiting_physical_confirmation|awaiting_speech_handoff)$/.test(value.status)
      && typeof value.ticket === "string" && /^[a-f0-9]{32}$/.test(value.ticket) ? value.ticket : undefined;
  } catch { return; }
}
