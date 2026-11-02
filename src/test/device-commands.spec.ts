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
for (const text of ["Report system status","What is your temperature?","Show me current CPU usage","Check RAM usage"]) {
  test(`actual measurements: ${text}`,()=>assert.deepEqual(parseDeviceCommand(text),{name:"getSystemHealth",args:{}}));
}
for (const text of [
  "Don't turn the volume down", "Never lower volume", "If I am loud turn volume down",
  "Turn volume down and reboot", "Set volume to 40 or 50", "Turn volume up then go Home",
  "Tell me a story about turning volume down", "Explain how to lower the volume", "Can I adjust volume?",
  "What happens when you lower your volume?", "I remember that you set volume to 80",
  "Remember that I like volume at 40", "Turn volume down by -5", "Set volume to 10.5%",
  "Set volume to 101", "Set brightness to 0", "Turn volume down by one hundred five percent",
  "Set volume to 40; shutdown", "run rm -rf", "SSH is down; restart it", "Restart SSH",
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
