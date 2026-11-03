import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { withWhisplayQuestion, whisplayTool } from "../config/whisplay-tools";
import { executeToolCall } from "../config/tool-execution";
import { withToolSignal } from "../utils/operation-lifecycle";
import { toolsRelevantTo } from "../config/tool-router";
import { whisplayHandoffTicket, presentWhisplayHandoff } from "../device/whisplay-control";

test("voice bridge uses validated RPC, always offers grounded tools, cancels pending handoff on interruption", async t => {
  const old = process.env.WHISPLAY_VOICE_CONTROL_ENABLED;
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED = "true";
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\whisplay-voice-${process.pid}` : path.join(os.tmpdir(), `voice-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET = socketPath;
  const requests: any[] = [];
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const server = net.createServer(connection => {
    connection.once("data", chunk => {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      const payload = request.cmd === "control.read" ? { api: 1, readable: ['audio'], actions: { volume: { supported: true } } }
        : request.cmd === "control.cancel" ? { status: "cancelled" }
        : { status: "awaiting_physical_confirmation", ticket: "a".repeat(32), changed: false };
      connection.end(JSON.stringify({ ok: true, payload }) + "\n");
      if (request.cmd === "control.cancel") cancelled();
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    if (old === undefined) delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED; else process.env.WHISPLAY_VOICE_CONTROL_ENABLED = old;
    delete process.env.WHISPLAY_CONTROL_SOCKET;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const invoke = (args: unknown) => executeToolCall("whisplay", args, { enabled: true,
    allowedTools: [whisplayTool], registeredTools: [whisplayTool], handlers: { whisplay: whisplayTool.func } });
  const result = await invoke({ action: "capabilities" });
  assert.match(result.output, /supported/);
  assert.equal(requests[0].cmd, "control.read");
  const count = requests.length;
  for (const args of [{ action: "shell", command: "id" }, { action: "volume", level: 101 },
                      { action: "volume", level: true }, { action: "wifi", enabled: "false" }]) {
    assert.match((await invoke(args)).output, /^\[(error|rejected)\]/);
  }
  assert.equal(requests.length, count, "invalid arguments never reach the daemon");
  for (const [question,args] of [
    ["Don't enable Bluetooth",{action:"bluetooth",enabled:true}],
    ["Enable Bluetooth if I ask",{action:"bluetooth",enabled:true}],
    ["How can I mute you?",{action:"mute",enabled:true}],
    ["Turn off GLaDOS",{action:"shutdown"}],
    ["Close GLaDOS please",{action:"reboot"}],
    ["Can you shut down?",{action:"shutdown"}],
  ] as [string,any][]) {
    assert.match((await withWhisplayQuestion(question,()=>invoke(args))).output,/\[error\]/);
  }
  assert.equal(requests.length,count,"host denies negation, hypotheticals and app/power confusion before IPC");
  assert.equal((await withWhisplayQuestion("Restart Pi",()=>invoke({action:"reboot"}))).status,"success",
    "an explicit Pi request may reach daemon physical-confirmation validation");
  const names = toolsRelevantTo("How much RAM is left?", [whisplayTool, { function: { name: "getSystemHealth" } }]).map(t => t.function.name);
  assert.deepEqual(names, ["whisplay", "getSystemHealth"]);
  const controller = new AbortController();
  const pending = await withToolSignal(controller.signal, () => whisplayTool.func({ action: "wifi", enabled: false }));
  const ticket = whisplayHandoffTicket(pending)!;
  assert.equal(ticket, "a".repeat(32));
  controller.abort();
  await cancellation;
  await assert.rejects(presentWhisplayHandoff(ticket), /no longer belongs/);
  assert.equal(requests[requests.length-1].cmd, "control.cancel");
});
