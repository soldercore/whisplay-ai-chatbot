// Operating facts are rendered from validated tool results, like memory replies.
// A small model chooses intent; it cannot rewrite measurements or claim pending work completed.
import { isIPv4 } from "node:net";
import { personaName } from "./persona";
import { powerRequest } from "./device-commands";
const labels: Record<string,string> = { brightness: "screen brightness", volume: "speaker volume", home: "Home navigation",
  lock: "screen locking", recording: "GLaDOS recording lock", wifi: "Wi-Fi", bluetooth: "Bluetooth",
  service: "service start or restart", reboot: "reboot", shutdown: "shutdown",
  apps: "running applications", display: "display status", audio: "audio status", network: "network status", services: "service status" };
Object.assign(labels,{mute:"speaker mute and restore",wifi_scan:"Wi-Fi scanning",wifi_profile:"saved Wi-Fi connections",
  wifi_join:"joining visible Wi-Fi networks",bluetooth_scan:"Bluetooth scanning",bluetooth_device:"Bluetooth pairing and device connections"});
const clean = (value: unknown): string => String(value ?? "unavailable").replace(/[\x00-\x1f\x7f]/g," ").slice(0,100);
const quantity = (value: any): string => value && typeof value.value === "number" && Number.isFinite(value.value)
  ? `${value.value} ${value.unit === "°C" ? "degrees Celsius" : value.unit === "GiB" ? "gibibytes" : value.unit === "%" ? "percent" : clean(value.unit)}` : "unavailable";

const list = (items:string[]):string => items.length < 2 ? items.join("") : items.length === 2
  ? items.join(" and ") : items.slice(0,-1).join(", ")+", and "+items[items.length-1];
const wantsDetail = (q:string):boolean => !/\b(?:keep it (?:short|brief)|(?:without|no) (?:technical |extra )?details)\b/i.test(q)
  && /\b(?:in detail|in depth|step[- ]by[- ]step|tell me more|(?:full|complete|detailed)(?: [a-z]+){0,2} (?:list|details|explanation|breakdown)|list (?:all|every)|technical details)\b/i.test(q);
let overviewSequence = 0;
function capabilityOverview(r:any):string {
  const v = overviewSequence++ % 3;
  const has = (key:string) => r.actions[key]?.supported === true;
  const reads = (...keys:string[]) => keys.some(key=>r.readable.includes(key));
  const tasks:string[] = [];
  if (has("brightness") && has("volume")) tasks.push(["adjust brightness and speaker volume","change screen brightness and volume","set screen brightness and speaker volume"][v]);
  else if (has("brightness")) tasks.push("adjust screen brightness");
  else if (has("volume")) tasks.push("adjust speaker volume");
  else if (has("mute")) tasks.push("mute or restore my speaker");
  else if (has("lock")) tasks.push("lock the screen");
  const connections = reads("network","wifi","bluetooth"), services = reads("services");
  if (connections && services) tasks.push(["check connections and running services","inspect connections and running services","check my connections and services"][v]);
  else if (connections) tasks.push("check connections");
  else if (services) tasks.push("check running services");
  else if (reads("apps")) tasks.push("check running applications");
  else if (reads("audio","display")) tasks.push("read "+list([...(reads("audio")?["audio"]:[]),...(reads("display")?["screen"]:[])])+" status");
  if (has("home")) tasks.push(["return to Home","take you back to Home","open the Home screen"][v]);
  if (!tasks.length) return "No device functions are confirmed available through this connection.";
  const confirmation = Object.values(r.actions).some((a:any)=>a?.supported === true && a.physical_confirmation === true);
  const glados = personaName() === "glados";
  const ending = confirmation ? (glados && v === 0
    ? "Some changes need confirmation with the button; supervision remains mandatory."
    : "Some changes still need your confirmation with the physical button.")
    : glados && v === 0 ? "A modest collection, but sufficient for ordinary requests."
    : "Those are the device functions currently available.";
  return `${v === 1 ? "You can ask me to" : "I can"} ${list(tasks)}. ${ending}`;
}

const serviceLabels:Record<string,string> = {ssh:"SSH",ollama:"Ollama",whisper:"Whisper",piper:"Piper",daemon:"Whisplay",glados:"GLaDOS"};
function serviceOverview(r:any, question:string):string {
  const requested = Object.keys(serviceLabels).filter(key=>key !== "glados" && new RegExp(`\\b${key}\\b`,"i").test(question));
  const states:Record<string,unknown> = {...r.services,...(typeof r.glados === "string"?{glados:r.glados}:{})};
  const groups = new Map<string,string[]>();
  for (const key of requested.length ? requested : Object.keys(states).filter(key=>serviceLabels[key])) {
    const value = typeof states[key] === "string" ? (states[key] as string).toLowerCase() : "";
    const state = ["running","stopped","failed","not installed"].includes(value) ? value : "unavailable";
    groups.set(state,[...(groups.get(state)||[]),serviceLabels[key]]);
  }
  if (!groups.size) return "Service status is unavailable.";
  const clauses = [...groups].map(([state,names])=>state === "unavailable" ? `Status is unavailable for ${list(names)}`
    : `${list(names)} ${state === "failed" ? names.length > 1 ? "have failed" : "has failed" : `${names.length > 1 ? "are" : "is"} ${state}`}`);
  return clauses.join("; ")+"."+(/\b(working|available|reachable|access)\b/i.test(question) ? " Access has not been tested." : "");
}

export function deviceResultSpeech(name: string, output: string, metric?: "temperature"|"memory"|"storage"|"cpu"|"ip", question = ""): string | undefined {
  if (process.env.WHISPLAY_VOICE_CONTROL_ENABLED !== "true") return;
  if (name === "whisplay" && output.startsWith("[error]")) {
    if (metric === "ip") return "The network lookup failed. Local Wi-Fi IP information is unavailable.";
    let reason="";try{reason=JSON.parse(output.slice(7)).reason||"";}catch{}
    if (/fixed privilege helper/i.test(reason)) return "That operation is unavailable: the fixed privileged control helper is missing or not authorized.";
    if (/disruptive wi-fi|automatic recovery/i.test(reason)) return "That Wi-Fi change is unavailable until offline recovery is verified. Your connection has been left alone.";
    if (/active ssh|ssh session/i.test(reason)) return "That change is blocked while SSH is connected. I will preserve your connection.";
    if (/entire raspberry pi/i.test(reason)) return "Do you mean the entire Raspberry Pi? Power actions require a clear request and confirmation with the button.";
    if (/closing glados uses home/i.test(reason)) return "Closing GLaDOS returns to Home. A Raspberry Pi power action needs an explicit Pi request and physical confirmation.";
    return "I could not verify completion of that device request. No change was confirmed.";
  }
  if (!output.startsWith("[success]")) return metric === "ip" ? "Local Wi-Fi IP information is unavailable: the network lookup did not return a verified result." : undefined;
  let r: any;
  try { r = JSON.parse(output.slice(9)); } catch { return metric === "ip" ? "Local Wi-Fi IP information is unavailable: the network tool returned no usable result." : undefined; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return metric === "ip" ? "Local Wi-Fi IP information is unavailable: the network tool returned no usable result." : undefined;
  const detailed = wantsDetail(question);
  if (name === "getSystemHealth") {
    if (metric === "temperature") return `CPU temperature is ${quantity(r.temperature)}.`;
    if (metric === "memory") return `RAM available is ${quantity(r.memory?.available)}, and RAM used is ${quantity(r.memory?.used)}.`;
    if (metric === "storage") return `Storage available is ${quantity(r.disk?.available)}.`;
    if (metric === "cpu") return `CPU usage is ${quantity(r.cpu?.utilization)}.`;
    if (!detailed) return `CPU usage is ${quantity(r.cpu?.utilization)}, and temperature is ${quantity(r.temperature)}. `
      + `RAM used is ${quantity(r.memory?.used)}, RAM available is ${quantity(r.memory?.available)}, and storage available is ${quantity(r.disk?.available)}.`;
    return `CPU usage is ${quantity(r.cpu?.utilization)}. CPU temperature is ${quantity(r.temperature)}. `
      + `RAM used is ${quantity(r.memory?.used)}, and RAM available is ${quantity(r.memory?.available)}. `
      + `Storage available is ${quantity(r.disk?.available)}.`;
  }
  if (name !== "whisplay") return;
  if (metric === "ip") {
    const wifi = r.wifi;
    if (!wifi || wifi.available === false) return "Local Wi-Fi IP information is unavailable.";
    const iface = typeof wifi.device === "string" && /^[a-zA-Z0-9_.:-]{1,32}$/.test(wifi.device) ? wifi.device : undefined;
    const addresses = (Array.isArray(wifi.connected) ? wifi.connected : [])
      .filter((n:any) => n?.active === true && typeof n.ipv4 === "string" && isIPv4(n.ipv4) && n.ipv4 !== "0.0.0.0")
      .slice(0,4).map((n:any) => n.ipv4);
    if (!addresses.length) return `No local Wi-Fi IPv4 address was reported${iface ? " for " + iface : ""}. Other interfaces and public IP addresses were not checked.`;
    return `Local Wi-Fi IPv4 address is ${addresses.join(", ")}${iface ? " on " + iface : "; the interface was not reported"}.`;
  }
  if (r.api === 1 && r.actions && Array.isArray(r.readable)) {
    const power = powerRequest(question);
    if (power === "clarify") return `Do you mean ${/\b(restart|reboot)\b/i.test(question) ? "restart" : "turn off"} the entire Raspberry Pi?`;
    if (power === "capability") return r.actions.shutdown?.supported === true && r.actions.reboot?.supported === true
      ? "I can shut down or restart the entire Raspberry Pi, after a clear request and confirmation with the physical button."
      : "System shutdown and restart are unavailable: the privileged control helper is missing or not authorized.";
    if (/connect to (?:my |the )?(?:wi-?fi|wireless)/i.test(question)) return r.actions.wifi_profile?.supported === true
      ? "Which saved Wi-Fi network do you want to connect to?"
      : "Connecting or switching Wi-Fi is unavailable until offline recovery is verified. I can still check the current connection.";
    if (!detailed) return capabilityOverview(r);
    const allowed = Object.keys(labels).filter(key => r.actions[key]?.supported === true).map(key => labels[key]);
    const denied = Object.keys(labels).filter(key => r.actions[key]?.supported === false).map(key => labels[key]);
    const confirmations = Object.keys(labels).filter(key => r.actions[key]?.supported && r.actions[key]?.physical_confirmation)
      .map(key => r.actions[key].immediate_disable_when_idle ? `${labels[key]} changes affecting connected devices`
        : r.actions[key].immediate_enable ? `disabling ${labels[key]}` : labels[key]);
    return `I can read ${r.readable.filter((key: string) => labels[key]).map((key: string) => labels[key]).join(", ")}, and actual CPU, RAM, temperature and storage. `
      + `Available controls are ${allowed.join(", ") || "none"}. `
      + (confirmations.length ? `${confirmations.join(", ")} require the physical confirmation screen. ` : "")
      + (denied.length ? `Not available through this connection: ${denied.join(", ")}. ` : "")
      + "The recording lock affects GLaDOS only; it is not a hardware microphone mute. Screen wake and recording unlock remain available with the physical button and Audio menu.";
  }
  if (r.status === "completed" && ["volume","brightness"].includes(r.action) && typeof r.actual === "number") {
    return `${r.action === "volume" ? "Speaker volume" : "Screen brightness"} is set to ${r.actual} percent.`;
  }
  if (r.status === "completed" && r.action === "mute") {
    if (r.enabled && r.requested_enabled === false) return "The speaker is still muted; restoring sound was not confirmed.";
    return r.enabled ? "Speaker muted. Push-to-talk and the physical Audio controls remain available."
      : `Speaker sound restored to ${clean(r.actual)} percent.`;
  }
  if (r.status === "completed" && ["wifi","bluetooth"].includes(r.action)) return typeof r.enabled === "boolean"
    ? `${labels[r.action]} is ${r.changed === false ? "already " : ""}${r.enabled ? "enabled" : "disabled"}.`
    : `${labels[r.action]} radio state could not be verified.`;
  if (r.status === "completed" && r.action === "bluetooth_device" && r.verification === "BlueZ_readback") return `Connected to ${clean(r.device)}.`;
  if (r.status === "completed" && r.action === "recording") return "GLaDOS recording is already enabled. Push-to-talk remains active only while you press the button.";
  if (r.status === "completed" && r.action === "wifi_join" && r.already_connected) return `Wi-Fi is already connected to ${clean(r.network)}.`;
  if (r.status === "completed" && r.action === "wifi_scan") return `Wi-Fi scan completed. Networks reported: ${(r.networks||[]).slice(0,5).map((n:any)=>clean(n.ssid)).join(", ")||"none"}.`;
  if (r.status === "completed" && r.action === "bluetooth_scan") return `Bluetooth scan completed. Devices reported: ${(r.devices||[]).slice(0,5).map((n:any)=>clean(n.name)).join(", ")||"none"}.`;
  if (["awaiting_physical_confirmation", "awaiting_speech_handoff"].includes(r.status)) {
    if (r.status === "awaiting_physical_confirmation" && ["shutdown","reboot"].includes(r.action)) {
      return `${r.action === "shutdown" ? "Shut down" : "Restart"} the entire system? Confirm with the physical button after this reply; Cancel is selected first.`;
    }
    const target = r.requested?.action === "service" ? `${clean(r.requested.operation)} ${clean(r.requested.service)}`
      : r.action === "recording" ? `${r.requested?.enabled ? "Enable" : "Lock"} GLaDOS recording`
      : r.action === "bluetooth_device" ? `${clean(r.requested.operation)} Bluetooth device ${clean(r.requested.device)}` : labels[r.action];
    return r.status === "awaiting_physical_confirmation"
      ? `${target} is pending. Nothing has changed. After this reply I will stop GLaDOS and show the existing local controls. Cancel is selected first; use the button to continue or cancel.${r.action === "wifi_join" ? " Wi-Fi credentials, if needed, are entered only there." : ""}`
      : r.action === "home" ? "I will return to Home after this reply." : "I will lock the screen after this reply. Press the button to wake it.";
  }
  if (Array.isArray(r.apps)) return r.apps.map((app: any) => `${clean(app.display_name)} is ${app.running ? "running" : "stopped"}${app.foreground ? " in the foreground" : ""}.`).join(" ");
  if (r.services) return detailed ? Object.entries(r.services).map(([name,state]) => `${clean(name)} is ${clean(state)}.`).join(" ")
    + ` GLaDOS is ${clean(r.glados)}. These service states do not establish remote reachability or backend readiness.` : serviceOverview(r,question);
  if (r.scope === "audio") return `Speaker volume is ${clean(r.speaker_percent)} percent. GLaDOS recording is ${r.glados_recording_enabled ? "enabled" : "locked"}. ${clean(r.input_mode)}. Hardware microphone mute is not supported.`;
  if (r.scope === "display") return `Screen brightness is set to ${clean(r.brightness_percent)} percent. The screen is ${r.screen_locked ? "locked" : "unlocked"}.`;
  if (["network","wifi","bluetooth"].includes(r.scope)) {
    const wifi = r.wifi?.enabled === true ? "enabled" : r.wifi?.enabled === false ? "disabled" : "unavailable";
    const bt = r.bluetooth?.enabled === true ? "enabled" : r.bluetooth?.enabled === false ? "disabled" : "unavailable";
    const connected = (r.wifi?.connected || []).map((n: any) => `${clean(n.ssid)}, IP ${clean(n.ipv4)}`).join(", ");
    const devices=(r.bluetooth?.devices||[]).slice(0,5).map((n:any)=>`${clean(n.name)}${n.connected?", connected":n.paired?", paired":""}`).join("; ");
    const signal = (r.wifi?.connected || []).filter((n:any)=>n.active === true && Number.isInteger(n.signal) && n.signal >= 0 && n.signal <= 100).map((n:any)=>n.signal);
    const strength = /\b(signal|strength)\b/i.test(question) ? signal.length ? ` Signal strength is ${signal[0]} percent.` : " Signal strength is unavailable." : "";
    return (r.scope !== "bluetooth" ? `Wi-Fi is ${wifi}${connected ? ", connected to " + connected : ", no active connection was reported"}.${strength} Internet reachability has not been tested. `:"")
      + (r.scope !== "wifi" ? `Bluetooth is ${bt}.${devices?" Devices: "+devices+".":""}${r.bluetooth?.details_complete===false?" Some device details were unavailable.":""}`:"");
  }
  return;
}
