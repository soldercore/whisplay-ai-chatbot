// Credentials belong to the existing masked local Wi-Fi screen, never the
// spoken control protocol, transcript log, model context or persistent history.
export const WIFI_PRIVATE = "[Wi-Fi password withheld]";
export const wifiCredentialReply = "Wi-Fi passwords must be entered on the local Network screen. I will not repeat or save them.";
export function redactWifiCredentials(text: string): string {
  if (process.env.WHISPLAY_VOICE_CONTROL_ENABLED !== "true") return text;
  return /\b(?:wi[ -]?fi|wireless|network|ssid)\b/i.test(text)
    && /\b(?:password|passphrase|psk|security key)\b/i.test(text) ? WIFI_PRIVATE : text;
}

// Invalid extra parameters must still fail schema validation. Remove their
// values before tool logging/history, rather than accepting a credential field.
export function privateWhisplayCall<T>(call: T): T {
  const value = call as any;
  if (value?.function?.name !== "whisplay") return call;
  const allowed = new Set(["action","scope","level","change","enabled","service","operation","device","profile","network"]);
  const raw = value.function.arguments;
  let args = raw;
  try { if (typeof raw === "string") args = JSON.parse(raw); } catch { args = "[invalid Whisplay arguments withheld]"; }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    args = Object.fromEntries(Object.entries(args).map(([key, item]) => [key,
      !allowed.has(key) ? "[unsupported parameter withheld]" : typeof item === "string" ? redactWifiCredentials(item)
        : item && typeof item === "object" ? "[invalid parameter withheld]" : item]));
  } else {
    args = "[invalid Whisplay arguments withheld]";
  }
  return {...value, function:{...value.function, arguments:typeof raw === "string" ? JSON.stringify(args) : args}};
}
