// Operating facts are rendered from validated tool results, like memory replies.
// A small model chooses intent; it cannot rewrite measurements or claim pending work completed.
const labels: Record<string,string> = { brightness: "screen brightness", volume: "speaker volume", home: "Home navigation",
  lock: "screen locking", recording: "GLaDOS recording lock", wifi: "Wi-Fi", bluetooth: "Bluetooth",
  service: "service start or restart", reboot: "reboot", shutdown: "shutdown",
  apps: "running applications", display: "display status", audio: "audio status", network: "network status", services: "service status" };
const clean = (value: unknown): string => String(value ?? "unavailable").replace(/[\x00-\x1f\x7f]/g," ").slice(0,100);
const quantity = (value: any): string => value && typeof value.value === "number" && Number.isFinite(value.value)
  ? `${value.value} ${value.unit === "°C" ? "degrees Celsius" : value.unit === "GiB" ? "gibibytes" : value.unit === "%" ? "percent" : clean(value.unit)}` : "unavailable";

export function deviceResultSpeech(name: string, output: string): string | undefined {
  if (process.env.WHISPLAY_VOICE_CONTROL_ENABLED !== "true" || !output.startsWith("[success]")) return;
  let r: any;
  try { r = JSON.parse(output.slice(9)); } catch { return; }
  if (name === "getSystemHealth") {
    return `CPU usage is ${quantity(r.cpu?.utilization)}. CPU temperature is ${quantity(r.temperature)}. `
      + `RAM used is ${quantity(r.memory?.used)}, and RAM available is ${quantity(r.memory?.available)}. `
      + `Storage available is ${quantity(r.disk?.available)}.`;
  }
  if (name !== "whisplay") return;
  if (r.api === 1 && r.actions && Array.isArray(r.readable)) {
    const allowed = Object.keys(labels).filter(key => r.actions[key]?.supported === true).map(key => labels[key]);
    const denied = Object.keys(labels).filter(key => r.actions[key]?.supported === false).map(key => labels[key]);
    const confirmations = Object.keys(labels).filter(key => r.actions[key]?.supported && r.actions[key]?.physical_confirmation).map(key => labels[key]);
    return `I can read ${r.readable.filter((key: string) => labels[key]).map((key: string) => labels[key]).join(", ")}, and actual CPU, RAM, temperature and storage. `
      + `Available controls are ${allowed.join(", ") || "none"}. `
      + (confirmations.length ? `${confirmations.join(", ")} require the physical confirmation screen. ` : "")
      + (denied.length ? `Not available through this connection: ${denied.join(", ")}. ` : "")
      + "The recording lock affects GLaDOS only; it is not a hardware microphone mute.";
  }
  if (r.status === "completed" && ["volume","brightness"].includes(r.action) && typeof r.actual === "number") {
    return `${r.action === "volume" ? "Speaker volume" : "Screen brightness"} is set to ${r.actual} percent.`;
  }
  if (["awaiting_physical_confirmation", "awaiting_speech_handoff"].includes(r.status)) {
    const target = r.requested?.action === "service" ? `${clean(r.requested.operation)} ${clean(r.requested.service)}` : labels[r.action];
    return r.status === "awaiting_physical_confirmation"
      ? `${target} is pending. Nothing has changed. After this reply I will stop GLaDOS and show the local Cancel-first confirmation screen. Use the button to confirm or cancel.`
      : r.action === "home" ? "I will return to Home after this reply." : "I will lock the screen after this reply. Press the button to wake it.";
  }
  if (Array.isArray(r.apps)) return r.apps.map((app: any) => `${clean(app.display_name)} is ${app.running ? "running" : "stopped"}${app.foreground ? " in the foreground" : ""}.`).join(" ");
  if (r.services) return Object.entries(r.services).map(([name,state]) => `${clean(name)} is ${clean(state)}.`).join(" ")
    + ` GLaDOS is ${clean(r.glados)}. These service states do not establish remote reachability or backend readiness.`;
  if (r.scope === "audio") return `Speaker volume is ${clean(r.speaker_percent)} percent. GLaDOS recording is ${r.glados_recording_enabled ? "enabled" : "locked"}. ${clean(r.input_mode)}. Hardware microphone mute is not supported.`;
  if (r.scope === "display") return `Screen brightness is set to ${clean(r.brightness_percent)} percent. The screen is ${r.screen_locked ? "locked" : "unlocked"}.`;
  if (r.scope === "network") {
    const wifi = r.wifi?.enabled === true ? "enabled" : r.wifi?.enabled === false ? "disabled" : "unavailable";
    const bt = r.bluetooth?.enabled === true ? "enabled" : r.bluetooth?.enabled === false ? "disabled" : "unavailable";
    const connected = (r.wifi?.connected || []).map((n: any) => `${clean(n.ssid)}, IP ${clean(n.ipv4)}`).join(", ");
    return `Wi-Fi is ${wifi}${connected ? ", connected to " + connected : ""}. Bluetooth is ${bt}. Internet reachability has not been tested.`;
  }
  return;
}
