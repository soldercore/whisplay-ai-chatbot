// Whole, simple requests only. Anything conditional, compound or conversational
// stays on the existing Qwen path; this parser never grants execution permission.
export type DeviceCommand = { name: "whisplay" | "getSystemHealth"; args: Record<string, any>; metric?: "temperature" | "memory" | "storage" | "cpu" | "ip" };

const ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const tens = ["twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
const numberPattern = `(?:\\d{1,3}|one hundred|a hundred|${ones.join("|")}|(?:${tens.join("|")})(?:[ -](?:${ones.slice(1,10).join("|")}))?)`;
export function deviceNumber(text: string): number | undefined {
  const word = text.trim().replace(/-/g," ");
  let value = /^\d{1,3}$/.test(word) ? Number(word) : ones.indexOf(word);
  if (value < 0 && /^(?:one|a) hundred$/.test(word)) value = 100;
  if (value < 0) {
    const [ten, one] = word.split(" ");
    const index = tens.indexOf(ten);
    if (index >= 0 && (!one || ones.slice(1,10).includes(one))) value = (index+2)*10 + (one ? ones.indexOf(one) : 0);
  }
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

const volume = "(?:(?:your|the) )?(?:(?:speaker|sound) )?(?:volume|speaker)";
const brightness = "(?:(?:your|the) )?(?:screen(?: brightness)?|display(?: brightness)?|brightness)";
const unit = "(?: ?(?:%|percent|percentage points?))?";
const amount = `(?:a little|a bit|slightly|(?:by |to )?${numberPattern}${unit})`;
const match = (text: string, pattern: string) => new RegExp(`^(?:${pattern})$`).exec(text);

export function deviceCommandText(text: string): string {
  if (text.length > 240) return "";
  let value = text.toLowerCase().replace(/[’]/g,"'").trim().replace(/[.!?]+$/g,"").replace(/\s+/g," ");
  value = value.replace(/^(?:hey )?glados[, ]+/,"");
  value = value.replace(/^(?:please (?:just )?|(?:can|could|would|will) you (?:please )?(?:just )?)/,"");
  return value.replace(/,? please$/,"").trim();
}

export function parseDeviceCommand(text: string): DeviceCommand | undefined {
  const q = deviceCommandText(text);
  if (!q) return;
  // Read-only checks accept "check if", but not an extra requested operation.
  const service = "(?:(?:the |your )?(?:ssh|ollama|piper|whisper|faster[- ]whisper|whisplay daemon|daemon)(?: service)?)";
  if (match(q,`(?:is ${service} (?:working|running|available|up|on)|(?:check (?:whether |if )?|tell me whether )${service} is (?:working|running|available|up|on)|(?:show|check|report)(?: me)? (?:the |your )?service (?:status|availability)|what(?: is|'s) (?:the )?status of ${service})`)) {
    return { name:"whisplay", args:{action:"status",scope:"services"} };
  }
  // These whole requests are read-only, including "check if". Never interpret
  // public/user/other-device addresses or an extra requested action as local IP.
  const ip = "(?:(?:your|whisplay's|this (?:device|pi|raspberry pi)'s) (?:(?:local|wi-?fi) )?(?:ip|ipv4)(?: address)?|the (?:(?:local|wi-?fi) )?(?:ip|ipv4) address (?:of|for) (?:this|the) (?:device|pi|raspberry pi|whisplay))";
  if (match(q,`(?:(?:what(?: is|'s)|which is) ${ip}|(?:show|tell|give)(?: me)? ${ip}|(?:check|read|report|get|find)(?: me)? ${ip}|tell me (?:what|which) ${ip} is|(?:what|which) (?:(?:local|wi-?fi) )?(?:ip|ipv4) address (?:are you using|do you have))`)) {
    return {name:"whisplay",args:{action:"status",scope:"wifi"},metric:"ip"};
  }
  if (match(q,"(?:are you (?:connected to|on) (?:wi-?fi|the network)|do you have a wi-?fi connection|is (?:your |the )?wi-?fi (?:connected|on|off|enabled|disabled)|check (?:if |whether )?(?:your |the )?wi-?fi is (?:connected|on|off|enabled|disabled)|(?:show|check|report|read)(?: me)? (?:your |the |current )?(?:wi-?fi|network)(?: (?:status|connection))?|what(?: is|'s) (?:your |the )?(?:wi-?fi|network) (?:status|connection)|what(?: is|'s) your (?:wi-?fi|network))")) {
    return {name:"whisplay",args:{action:"status",scope:"wifi"}};
  }
  if (match(q,"(?:is (?:your |the )?bluetooth (?:on|off|enabled|disabled|connected)|check (?:if |whether )?(?:your |the )?bluetooth is (?:on|off|enabled|disabled|connected)|(?:show|check|report|read)(?: me)? (?:your |the |current )?bluetooth(?: status)?|what(?: is|'s) (?:your |the )?bluetooth status|what(?: is|'s) your bluetooth|which bluetooth devices are connected)")) {
    return {name:"whisplay",args:{action:"status",scope:"bluetooth"}};
  }
  if (/\b(?:not|don't|dont|never|if|unless|when|after|before|and|then|or|except)\b/.test(q)) return;
  if (match(q,"(?:(?:go|bring me|take me|return)(?: back)?(?: to)?|return me to|open) (?:the )?home(?: (?:screen|menu))?|(?:exit|close|quit) (?:glados|the chatbot)|(?:turn|switch) off (?:glados|yourself)|(?:turn|switch) (?:glados|yourself) off|shut (?:down glados|glados down)")) {
    return {name:"whisplay",args:{action:"home"}};
  }
  if (match(q,"(?:show|list|tell me) (?:your|whisplay's|the device's) (?:functions|features|capabilities)")) return {name:"whisplay",args:{action:"capabilities"}};
  if (match(q,"how hot are you|what(?: is|'s) (?:your|the cpu) temperature")) return {name:"getSystemHealth",args:{},metric:"temperature"};
  if (match(q,"(?:how much (?:ram|memory) (?:is available|is free|do you have)|(?:show|check) (?:available |free )?ram)")) return {name:"getSystemHealth",args:{},metric:"memory"};
  if (match(q,"(?:how much (?:disk |storage )?space (?:is left|is available|is free|do you have)|(?:show|check) (?:free |available )?(?:storage|disk space))")) return {name:"getSystemHealth",args:{},metric:"storage"};
  if (match(q,"(?:what(?: is|'s) (?:currently )?running|which services are running|show (?:running )?services)")) return {name:"whisplay",args:{action:"status",scope:"services"}};
  if (match(q,"(?:which apps are running|show (?:running )?(?:apps|applications))")) return {name:"whisplay",args:{action:"status",scope:"apps"}};
  if (match(q,"(?:show|check) (?:your |the )?(?:screen|display)(?: status)?")) return {name:"whisplay",args:{action:"status",scope:"display"}};
  if (match(q,"(?:mute|silence)(?: (?:yourself|your speaker|the speaker|your volume))?")) return {name:"whisplay",args:{action:"mute",enabled:true}};
  if (match(q,"(?:unmute|restore)(?: (?:yourself|your speaker|the speaker|your volume|the volume|sound))?")) return {name:"whisplay",args:{action:"mute",enabled:false}};
  if (match(q,"(?:lock|turn off|switch off) (?:your |the )?screen|lock (?:your |the )?display")) return {name:"whisplay",args:{action:"lock"}};
  let extra = match(q,"(enable|disable|lock|unlock) (?:glados )?recording|turn (on|off) (?:glados )?recording");
  if (extra) return {name:"whisplay",args:{action:"recording",enabled:["enable","unlock","on"].includes(extra[1]||extra[2])}};
  extra = match(q,"(enable|disable|turn on|turn off|switch on|switch off) (?:your |the )?(wi-?fi|bluetooth)");
  if (extra) return {name:"whisplay",args:{action:extra[2]==="bluetooth"?"bluetooth":"wifi",enabled:["enable","turn on","switch on"].includes(extra[1])}};
  if (match(q,"(?:scan|look|search) for (?:wi-?fi|networks|wi-?fi networks)")) return {name:"whisplay",args:{action:"wifi_scan"}};
  if (match(q,"(?:scan|look|search) for bluetooth(?: devices)?")) return {name:"whisplay",args:{action:"bluetooth_scan"}};
  extra = match(q,"(start|restart) (?:the )?(ssh|ollama|whisper|faster whisper|piper)(?: service)?");
  if (extra) return {name:"whisplay",args:{action:"service",operation:extra[1],service:extra[2]==="faster whisper"?"whisper":extra[2]}};
  if (match(q,"(?:restart|reboot) (?:the )?(?:raspberry pi|pi|device)")) return {name:"whisplay",args:{action:"reboot"}};
  if (match(q,"(?:shut down|shutdown|turn off) (?:the )?(?:raspberry pi|pi|device)")) return {name:"whisplay",args:{action:"shutdown"}};
  extra = match(q,"(?:your|the) (?:screen|display) is too (bright|dark)");
  if (extra) return {name:"whisplay",args:{action:"brightness",change:extra[1]==="bright"?-10:10}};
  extra = match(q,"make (?:yourself|your voice) (?:(?:a little|a bit|slightly) )?(quieter|louder)");
  if (extra) return {name:"whisplay",args:{action:"volume",change:extra[1]==="quieter"?-10:10}};
  if (match(q,"(?:show(?: me)?|report|check|tell me|what is|what's|give me) (?:your |the |current |actual )?(?:system (?:status|health|info|information)|cpu(?: usage| temperature)?|ram(?: usage)?|temperature|storage(?: space)?|disk space)|how(?: is|'s) (?:your|the) system doing")) {
    return {name:"getSystemHealth",args:{}};
  }
  for (const [action, target, lower, higher] of [
    ["volume",volume,"quieter","louder"], ["brightness",brightness,"darker","brighter"],
  ]) {
    let m = match(q,`(?:set|change|adjust|make) ${target} (?:to |at )?(${numberPattern})${unit}`);
    if (m) {
      const level = deviceNumber(m[1]);
      if (level === undefined || action === "brightness" && level < 20) return;
      return {name:"whisplay",args:{action,level}};
    }
    let sign = 0, tail = "";
    m = match(q,`turn ${target} (down|up)(?: (${amount}))?`)
      || match(q,`turn (down|up) ${target}(?: (${amount}))?`);
    if (m) { sign = m[1] === "down" ? -1 : 1; tail = m[2] || ""; }
    if (!sign) {
      m = match(q,`(lower|reduce|decrease|raise|increase) ${target}(?: (${amount}))?`);
      if (m) { sign = /^(lower|reduce|decrease)$/.test(m[1]) ? -1 : 1; tail = m[2] || ""; }
    }
    if (!sign) {
      m = match(q,`make ${target} (?:(a little|a bit|slightly) )?(${lower}|${higher})`)
        || match(q,`make ${target} (${lower}|${higher})(?: (a little|a bit|slightly))?`);
      if (m) { sign = m.includes(lower) ? -1 : 1; }
    }
    if (sign) {
      const value = !tail || /^(a little|a bit|slightly)$/.test(tail) ? 10 : deviceNumber(tail.replace(/^(by|to) /,"").replace(/ ?(%|percent|percentage points?)$/,""));
      if (value === undefined) return;
      if (tail.startsWith("to ")) {
        if (action === "brightness" && value < 20) return;
        return {name:"whisplay",args:{action,level:value}};
      }
      return {name:"whisplay",args:{action,change:sign*value}};
    }
  }
}

// Request-local host policy also constrains Qwen fallback proposals. It does not
// trust the model to interpret "little", or to invent a large absolute target.
export function preciseDeviceArguments(params: Record<string, any>, question?: string): Record<string, any> {
  if (!["volume","brightness"].includes(params.action) || !question) return params;
  const parsed = parseDeviceCommand(question);
  if (parsed?.name === "whisplay" && parsed.args.action === params.action) return parsed.args;
  const q = deviceCommandText(question);
  if (!q) throw new Error("Setting request cannot be safely confirmed");
  if (/\b(not|don't|dont|never|if|unless|when|after|before|then|except)\b/.test(q)) throw new Error("Conditional or negated setting request needs clarification");
  if (new RegExp(`\\b(tomorrow|later|tonight)\\b|\\bin ${numberPattern} (seconds?|minutes?|hours?)\\b`).test(q)) throw new Error("Deferred setting requests cannot execute immediately");
  const small = /\b(a little|a bit|slightly)\b/.test(q);
  const introduced = new RegExp(`\\b(by|to|at) (${numberPattern})${unit}$`).exec(q);
  let explicit = introduced ? { mode:introduced[1], number:introduced[2] } : undefined;
  if (!explicit) {
    const suffix = new RegExp(`\\b(?:up|down|volume|speaker|brightness|screen|display|it) (${numberPattern}) ?(?:%|percent|percentage points?)$`).exec(q);
    if (suffix) explicit = { mode:/\b(up|down|lower|reduce|decrease|raise|increase|quieter|louder|brighter|darker)\b/.test(q) ? "by" : "to", number:suffix[1] };
  }
  if (explicit) {
    const volumeMention = /\b(volume|speaker|sound|quieter|louder)\b/.test(q);
    const displayMention = /\b(screen|display|brightness|brighter|darker)\b/.test(q);
    if (volumeMention && displayMention || volumeMention && params.action !== "volume" || displayMention && params.action !== "brightness"
      || !volumeMention && !displayMention && !/\bit\b/.test(q)) throw new Error("Requested setting target is unclear");
    if (explicit.mode === "at" && !/(%|percent|percentage points?)$/.test(q)) throw new Error("Use an explicit percent target; a time cannot become a setting");
    const value = deviceNumber(explicit.number);
    if (value === undefined) throw new Error("Requested setting is outside supported bounds");
    if (explicit.mode !== "by") return {action:params.action,level:value};
    const down = /\b(down|lower|reduce|decrease|quieter|darker)\b/.test(q);
    const up = /\b(up|raise|increase|louder|brighter)\b/.test(q);
    if (down === up) throw new Error("Adjustment direction is unclear");
    const direction = down ? -1 : 1;
    return {action:params.action,change:direction*value};
  }
  if (typeof params.change === "number") {
    if (new RegExp(`\\d|\\b(?:${ones.join("|")}|${tens.join("|")}|hundred)\\b`).test(q) && !small) throw new Error("Could not safely confirm the requested number");
    const down = /\b(down|lower|reduce|decrease|quieter|darker)\b/.test(q);
    const up = /\b(up|raise|increase|louder|brighter)\b/.test(q);
    if (down && up) throw new Error("Adjustment direction is unclear");
    return {action:params.action,change:(down ? -1 : up ? 1 : Math.sign(params.change))*10};
  }
  if (small) {
    const down = /\b(down|lower|reduce|decrease|quieter|darker)\b/.test(q);
    const up = /\b(up|raise|increase|louder|brighter)\b/.test(q);
    if (down !== up) return {action:params.action,change:down ? -10 : 10};
    throw new Error("Small adjustment direction is unclear");
  }
  // Explicit nonnumeric mute requests retain their existing zero-level meaning.
  if (/\bmute\b/.test(q) && params.action === "volume" && params.level === 0) return params;
  throw new Error("Could not safely confirm the absolute target");
}
