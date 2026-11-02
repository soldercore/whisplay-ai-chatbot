// Explicit live demonstration, never part of npm test. Requires the temporary volume-only bridge.
import fs from "node:fs";
import provider from "../cloud-api/local/ollama-llm";
import { whisplayRequest } from "../device/whisplay-control";
import path from "node:path";
import { chatHistoryDir } from "../utils/dir";
import { needsSystemHealth } from "../config/tool-router";

async function main() {
  const output = process.env.WHISPLAY_DEMO_TRACE!;
  if (!output || !process.env.WHISPLAY_CONTROL_SOCKET) throw new Error("Explicit isolated demo socket/trace paths required");
  const before = await whisplayRequest("control.read", { scope: "audio" });
  const trace: any[] = [];
  let after: any;
  try {
    for (const question of [
      "Describe Whisplay's available controls.",
      "Tell me how hot you are, how much RAM is free and how much room is left on storage.",
      "Please make your speaker a little quieter.",
    ]) {
      provider.resetChatHistory();
      const entry: any = { question, calls: [], answer: "", started_at: new Date().toISOString() };
      trace.push(entry);
      console.log("[QUESTION]",question);
      await provider.chatWithLLMStream([{ role: "user", content: question }],
        text => { entry.answer += text; }, () => {}, undefined,
        (name, result) => {
          if (result === undefined) { entry.calls.push({ name }); console.log("[TOOL CALL]",name); }
          else { const call = [...entry.calls].reverse().find((c: any) => c.name === name && c.result === undefined);
            if (call) call.result = result; else entry.calls.push({ name, result });
            console.log("[TOOL RESULT]",name,result); }
        });
      entry.finished_at = new Date().toISOString();
      const historyFile = fs.readdirSync(chatHistoryDir).map(name => path.join(chatHistoryDir, name))
        .sort((a,b) => fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
      const history = JSON.parse(fs.readFileSync(historyFile,"utf8"));
      entry.tool_calls = history.filter((m: any) => m.role === "assistant")
        .flatMap((m: any) => (m.tool_calls || []).flat());
      entry.system_health_prefetch = needsSystemHealth(question);
      console.log("[ANSWER]",entry.answer);
      fs.writeFileSync(output,JSON.stringify({ before, interactions: trace },null,2));
    }
    after = await whisplayRequest("control.read", { scope: "audio" });
    fs.writeFileSync(output,JSON.stringify({ before, interactions: trace, after },null,2));
  } finally {
    const restored = await whisplayRequest("control.execute", { action: "volume", level: before.speaker_percent }, null);
    console.log("[RESTORED]",JSON.stringify(restored));
    fs.writeFileSync(output,JSON.stringify({ before, interactions: trace, after, restored },null,2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
