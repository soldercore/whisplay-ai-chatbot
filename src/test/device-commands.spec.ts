import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeviceCommand, preciseDeviceArguments } from "../config/device-commands";

const commands: [string,Record<string,unknown>][] = [
  ["GLaDOS, turn your volume down a little.",{action:"volume",change:-10}],
  ["Turn your volume up a little",{action:"volume",change:10}],
  ["Could you please lower the speaker volume slightly?",{action:"volume",change:-10}],
  ["Please turn down the volume",{action:"volume",change:-10}],
  ["Make your speaker a bit quieter",{action:"volume",change:-10}],
  ["Make the volume louder please",{action:"volume",change:10}],
  ["Reduce your volume by five percent",{action:"volume",change:-5}],
  ["Turn volume down by 30%",{action:"volume",change:-30}],
  ["Increase volume by twenty five percentage points",{action:"volume",change:25}],
  ["Could you just raise the volume by twenty-five percent?",{action:"volume",change:25}],
  ["Set your volume to 73 percent",{action:"volume",level:73}],
  ["Turn volume down to forty",{action:"volume",level:40}],
  ["Set volume to zero",{action:"volume",level:0}],
  ["Make your screen darker",{action:"brightness",change:-10}],
  ["Make your display slightly brighter",{action:"brightness",change:10}],
  ["Lower the brightness by 7%",{action:"brightness",change:-7}],
  ["Set screen brightness to ninety nine percent",{action:"brightness",level:99}],
  ["Take me back to Home.",{action:"home"}],
  ["Please open the Home menu",{action:"home"}],
  ["Can you check whether SSH is working?",{action:"status",scope:"services"}],
  ["Check if Piper is running",{action:"status",scope:"services"}],
  ["Report service availability",{action:"status",scope:"services"}],
];
for (const [text,args] of commands) test(`whole device command: ${text}`,()=>{
  assert.deepEqual(parseDeviceCommand(text),{name:"whisplay",args});
});
for (const text of ["Report system status","Show me current CPU usage","Check RAM usage"]) {
  test(`actual measurements: ${text}`,()=>assert.deepEqual(parseDeviceCommand(text),{name:"getSystemHealth",args:{}}));
}
for (const text of [
  "Don't turn the volume down", "Never lower volume", "If I am loud turn volume down",
  "Turn volume down and reboot", "Set volume to 40 or 50", "Turn volume up then go Home",
  "Tell me a story about turning volume down", "Explain how to lower the volume", "Can I adjust volume?",
  "What happens when you lower your volume?", "I remember that you set volume to 80",
  "Remember that I like volume at 40", "Turn volume down by -5", "Set volume to 10.5%",
  "Set volume to 101", "Set brightness to 0", "Turn volume down by one hundred five percent",
  "Set volume to 40; shutdown", "run rm -rf", "SSH is down; restart it",
  "Could you work out how to adjust your speaker so it is a little quieter?",
]) test(`uncertain or unsafe stays with Qwen: ${text}`,()=>assert.equal(parseDeviceCommand(text),undefined));

test("host precision overrides model size, preserves explicit values and refuses uncertain numbers",()=>{
  assert.deepEqual(preciseDeviceArguments({action:"volume",change:-20},commands[0][0]),{action:"volume",change:-10});
  assert.deepEqual(preciseDeviceArguments({action:"volume",level:0},"Could you somehow make your speaker a little quieter?"),{action:"volume",change:-10});
  assert.deepEqual(preciseDeviceArguments({action:"volume",change:20},"Could you somehow increase volume by 5 percent?"),{action:"volume",change:5});
  assert.deepEqual(preciseDeviceArguments({action:"volume",level:80},"I would like volume at 25 percent."),{action:"volume",level:25});
  assert.deepEqual(preciseDeviceArguments({action:"brightness",change:20},"I'd prefer a brighter screen"),{action:"brightness",change:10});
  assert.deepEqual(preciseDeviceArguments({action:"volume",change:20},"Turn it down by 5 percent"),{action:"volume",change:-5});
  assert.deepEqual(preciseDeviceArguments({action:"volume",level:80},"Turn it down 5%"),{action:"volume",change:-5});
  assert.deepEqual(preciseDeviceArguments({action:"volume",level:80},"Set it 25 percent"),{action:"volume",level:25});
  assert.throws(()=>preciseDeviceArguments({action:"volume",level:80},"Could you adjust the volume?"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",change:20},"Lower volume by one hundred five percent"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",change:20},"Turn volume up or down by five percent"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",change:-20},"Do not lower volume by 10 percent"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",change:20},"I would like the screen brighter by 10 percent"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",level:10},"Turn volume down a little at 10"));
  assert.throws(()=>preciseDeviceArguments({action:"volume",change:-20},"Turn volume down a little in ten minutes"));
});


test("voice exit variants close only GLaDOS; unsafe and conversational variants stay undecided", () => {
  for (const text of ["Go Home.","Bring me Home.","Exit GLaDOS.","Close GLaDOS.","Turn off GLaDOS.",
    "GLaDOS, take me back to Home.","Could you please close GLaDOS?","Turn GLaDOS off","Switch yourself off"]) {
    assert.deepEqual(parseDeviceCommand(text),{name:"whisplay",args:{action:"home"}},text);
  }
  for (const text of ["Don't go Home","If I say go Home, close GLaDOS","Tell me a story about going Home",
    "Remember that I go Home at five","Go Home and shut down the Pi","What does exit GLaDOS mean?","Could you close something?"]) {
    assert.equal(parseDeviceCommand(text),undefined,text);
  }
  assert.deepEqual(parseDeviceCommand("Shutdown the Raspberry Pi"),{name:"whisplay",args:{action:"shutdown"}});
});

test("ordinary installed controls have natural zero-inference interpretations", () => {
  const variants: [string,object][] = [
    ["Your screen is too bright",{action:"brightness",change:-10}],
    ["Can you make yourself quieter?",{action:"volume",change:-10}],
    ["Are you connected to Wi-Fi?",{action:"status",scope:"wifi"}],
    ["Check Bluetooth status",{action:"status",scope:"bluetooth"}],
    ["Enable Bluetooth",{action:"bluetooth",enabled:true}],
    ["Turn off WiFi",{action:"wifi",enabled:false}],
    ["Mute yourself",{action:"mute",enabled:true}], ["Unmute",{action:"mute",enabled:false}],
    ["Lock your screen",{action:"lock"}], ["Lock GLaDOS recording",{action:"recording",enabled:false}],
    ["What's currently running?",{action:"status",scope:"services"}],
    ["Restart SSH",{action:"service",service:"ssh",operation:"restart"}],
    ["Scan for Bluetooth devices",{action:"bluetooth_scan"}], ["Scan for Wi-Fi networks",{action:"wifi_scan"}],
  ];
  for(const [text,args] of variants) assert.deepEqual(parseDeviceCommand(text),{name:"whisplay",args},text);
  assert.deepEqual(parseDeviceCommand("How hot are you?"),{name:"getSystemHealth",args:{},metric:"temperature"});
  assert.deepEqual(parseDeviceCommand("What is your temperature?"),{name:"getSystemHealth",args:{},metric:"temperature"});
  for(const text of ["Enable Bluetooth if I ask","Don't mute yourself","Restart SSH tomorrow","Remember that I dislike bright screens"]) {
    assert.equal(parseDeviceCommand(text),undefined,text);
  }
});
