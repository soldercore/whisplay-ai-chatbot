import type { LLMTool } from "../type";
import { whisplayRequest, trackWhisplayHandoff } from "../device/whisplay-control";

export const whisplayVoiceControlEnabled = () => process.env.WHISPLAY_VOICE_CONTROL_ENABLED === "true";
// This only requires grounding; the model still chooses the operation/parameters.
export const requiresWhisplayTool = (text: string): boolean => whisplayVoiceControlEnabled()
  && !/\b(joke|poem|story|pretend|imagine)\b|^\s*(explain|define|how does)\b/i.test(text)
  && (/\b(whisplay|device|hardware|controls?|functions?|features?|capabilit\w*|screen|brightness|darker|brighter|speaker|volume|louder|quieter|microphone|recording|wi-?fi|bluetooth|ssh|services?|cpu|ram|storage|temperature|connection|home|reboot|shutdown)\b/i.test(text)
    || /\bwhat[\s\S]*\brunning\b/i.test(text));
export const needsWhisplayCapabilities = (text: string): boolean => whisplayVoiceControlEnabled()
  && !/\b(please|now|set|make|take|disable|enable|restart|shutdown)\b/i.test(text)
  && (/\b(what|which)\b[\s\S]*\b(capabilit\w*|functions?|features?|turn on or off)\b/i.test(text)
      && /\b(you|your|whisplay|device|available|on or off)\b/i.test(text)
    || /\bwhat\b[\s\S]*\bcan\b[\s\S]*\b(you|whisplay)\b[\s\S]*\bdo\b/i.test(text));

export const whisplayTool: LLMTool = {
  execution: "abortable", type: "function",
  function: {
    name: "whisplay",
    description: "Discover what you/Whisplay can do; read actual device state or control it. Call capabilities for ability questions. CPU/RAM/temperature/storage use getSystemHealth. Never claim a pending action completed. Handoffs occur after speech; risky actions require the physical Cancel-first screen. Recording is a GLaDOS-only lock, not hardware mute. Never speak ticket IDs.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["capabilities", "status", "brightness", "volume", "home", "lock", "recording", "wifi", "bluetooth", "service", "reboot", "shutdown"] },
        scope: { type: "string", enum: ["apps", "display", "audio", "network", "services"] },
        level: { type: "integer", minimum: 0, maximum: 100, description: "Absolute percent; use exactly one of level or change." },
        change: { type: "integer", minimum: -20, maximum: 20, description: "Small adjustment in percentage points. A little means 10; negative is darker/quieter." },
        enabled: { type: "boolean" },
        service: { type: "string", enum: ["ssh", "ollama", "whisper", "piper"] },
        operation: { type: "string", enum: ["start", "restart"] },
      }, required: ["action"],
    },
  },
  func: async (params: any) => {
    if (!whisplayVoiceControlEnabled()) return "[error]Whisplay voice integration is disabled.";
    try {
      const { action, ...args } = params;
      let result: any;
      if (action === "capabilities" || action === "status") {
        if (Object.keys(args).some(key => key !== "scope") || action === "capabilities" && args.scope !== undefined
          || action === "status" && !args.scope) throw new Error("Specify only a valid read scope");
        result = await whisplayRequest("control.read", { scope: action === "capabilities" ? "capabilities" : args.scope });
        if (action === "capabilities" && (result?.api !== 1 || !Array.isArray(result.readable)
          || !result.actions || typeof result.actions !== "object" || Array.isArray(result.actions))) {
          throw new Error("Paired daemon did not provide a valid capability report");
        }
        result = { ...result, scope: action === "capabilities" ? "capabilities" : args.scope };
      } else {
        result = await whisplayRequest("control.execute", params);
        if (!["completed", "awaiting_physical_confirmation", "awaiting_speech_handoff"].includes(result?.status)) {
          throw new Error("Daemon did not confirm an operation state");
        }
        if (result.ticket) trackWhisplayHandoff(result.ticket);
      }
      return "[success]" + JSON.stringify(result);
    } catch (error) {
      return "[error]" + JSON.stringify({ status: "unavailable_or_failed", changed: "not_confirmed",
        reason: (error as Error).message, note: "Do not claim success. Paired daemon API is required; do not use shell fallback." });
    }
  },
};

// Ollama grammar constraint for device intent. Execution still uses the existing
// offered-list/JSON fallback validator, never this decoder schema as permission.
export function deviceCallFormat(tools: readonly { function: { name: string } }[] = [], question = ""): object | undefined {
  const names = new Set(tools.map(tool => tool.function.name));
  // Same purpose as existing tool routing: keep a measurements-only question
  // out of unrelated control branches. No action or argument is inferred here.
  const metricsOnly = /\b(cpu|ram|temperature|storage|disk)\b/i.test(question)
    && !/\b(screen|brightness|volume|speaker|wi-?fi|bluetooth|services?|ssh|home|controls?|capabilit\w*|functions?|turn|on|off)\b/i.test(question);
  if (metricsOnly && names.has("getSystemHealth")) names.delete("whisplay");
  const variants: object[] = [];
  const props = (whisplayTool.function.parameters as any).properties;
  if (names.has("whisplay")) {
    const shapes: [string,string[]][] = [
      ["capabilities",[]], ["status",["scope"]], ["brightness",["level"]], ["brightness",["change"]],
      ["volume",["level"]], ["volume",["change"]], ["home",[]], ["lock",[]],
      ["recording",["enabled"]], ["wifi",["enabled"]], ["bluetooth",["enabled"]],
      ["service",["service","operation"]], ["reboot",[]], ["shutdown",[]],
    ];
    for (const [action, keys] of shapes) variants.push({ type:"object", additionalProperties:false,
      properties:{ name:{type:"string",enum:["whisplay"]}, arguments:{type:"object",additionalProperties:false,
        properties:{action:{type:"string",enum:[action]},...Object.fromEntries(keys.map(key=>[key,
          action === "brightness" && key === "level" ? {...props[key],minimum:20} : props[key]]))},
        required:["action",...keys]} }, required:["name","arguments"] });
  }
  if (names.has("getSystemHealth")) variants.push({type:"object",additionalProperties:false,
    properties:{name:{type:"string",enum:["getSystemHealth"]},arguments:{type:"object",properties:{},additionalProperties:false}},
    required:["name","arguments"]});
  return variants.length ? { oneOf: variants } : undefined;
}
