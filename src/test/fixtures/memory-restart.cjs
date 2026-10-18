// Run only through memory.spec.ts with the existing filesystem-isolation preload.
// Separate writer/reader processes share only an explicitly supplied fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const ts = require("typescript");

const [mode, directory, variant] = process.argv.slice(2);
assert.equal(process.env.WHISPLAY_TEST_ISOLATED, "1");
assert.ok(path.resolve(directory).startsWith(path.resolve(__dirname, "../../../.test-artifacts") + path.sep));
Object.assign(process.env, {
  MEMORY_ENABLED: "true", MEMORY_AUTO_SAVE: "false", MEMORY_DIR: directory, MEMORY_PROFILE_TEXT: "",
  MEMORY_MAX_SEARCH_RESULTS: "4", MEMORY_WAKEUP_MAX_ITEMS: "5",
  LLM_SERVER: "ollama", ASR_SERVER: "test", TTS_SERVER: "test", OLLAMA_MODEL: "test",
  OLLAMA_ENABLE_TOOLS: "true", OLLAMA_PREDICT_NUM: "1024", WEB_SEARCH_ENABLED: "false",
  MEMPALACE_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false", ENABLE_THINKING: "false",
  WAKE_WORD_ENABLED: "false", ASSISTANT_PERSONA: "glados",
});

const automatic = "What was the name of my imaginary robot that I asked you to remember?";
const explicit = "Search your saved memories. What is the name of my imaginary robot?";
const storePath = path.join(directory, "memory.json");
const emit = result => console.log("RESTART_RESULT=" + JSON.stringify({ pid: process.pid, ...result }));

async function main() {
  const memory = require("../../config/local-memory");
  if (mode === "write") {
    assert.ok(memory.handleMemoryCommand(variant));
    assert.ok(memory.handleMemoryCommand("Remember Obsidian calibration marker."));
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    emit({ persisted: store.userMemories.some(item => item.content.includes("Copper Finch")),
      version: store.version, imported: store.rememberedFactsImported, count: store.userMemories.length });
    return;
  }
  assert.equal(mode, "read");
  const before = fs.readFileSync(storePath, "utf8");
  const requests = [], injections = [];
  let currentQuestion = "", toolRequested = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", bytes => raw += bytes.toString("utf8"));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [{ name: "test", context_length: 4096 }] }));
      if (req.url === "/api/show") return res.end(JSON.stringify({ model_info: { context_length: 40960 } }));
      assert.equal(req.url, "/api/chat");
      const body = JSON.parse(raw);
      if (body.stream === false) return res.end(JSON.stringify({ done: true, done_reason: "load" }));
      // Capture serialized HTTP, after authorization routing, history and budgeting.
      requests.push({ question: currentQuestion, raw, body });
      res.setHeader("Content-Type", "application/x-ndjson");
      if (currentQuestion === explicit && !toolRequested) {
        toolRequested = true;
        return res.end(JSON.stringify({ message: { tool_calls: [{ function: {
          name: "searchLocalMemory", arguments: { query: "imaginary robot" },
        } }] }, done: true }) + "\n");
      }
      // This is a transport fixture, not evidence of real Qwen recall ability.
      res.end(JSON.stringify({ message: { content: "Fixture response." }, done: true }) + "\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  // Exercise real /api/ps HTTP instead of the preload's generic 32k fixture.
  const axios = require("axios");
  axios.get = (url, options) => axios.request({ ...options, method: "GET", url });
  const llm = require("../../cloud-api/llm");
  const source = fs.readFileSync(path.join(__dirname, "../../core/chat-flow/states.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const noop = () => {};
  let prepared = "", completed;
  const dependencies = {
    "../../device/display": { display: noop, onButtonPressed: noop, onButtonReleased: noop },
    "../../device/audio": {},
    "../../cloud-api/server": { llmServer: "ollama", chatWithLLMStream: (input, ...callbacks) => {
      injections.push({ question: currentQuestion, input });
      return llm.chatWithLLMStream(input, ...callbacks);
    } },
    "../../cloud-api/llm": llm,
    "../Knowledge": {}, "../../cloud-api/knowledge": { enableRAG: false },
    "../../utils/dir": require("../../utils/dir"),
    "../../utils/image": { clearPendingCapturedImgForChat: noop, getLatestDisplayImg: noop },
    "../../cloud-api/whisplay-im/whisplay-im": {}, "./camera-mode": {},
    "../../utils": {}, "../../device/music-player": {},
    "../../config/local-memory": { ...memory, prepareMemoryPrompt: question => {
      prepared = memory.prepareMemoryPrompt(question); return prepared;
    } },
    "../../config/unsupported-reminder": require("../../config/unsupported-reminder"),
  };
  const exported = {};
  vm.runInNewContext(compiled, { exports: exported, process, console, Date, setTimeout, clearTimeout,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (["moment", "lodash"].includes(name)) return require(name);
      throw new Error("Unexpected answer-state dependency: " + name);
    } });
  async function ask(question) {
    currentQuestion = question;
    const completion = new Promise(resolve => { completed = resolve; });
    const ctx = {
      asrText: question, answerId: 1, currentFlowName: "answer", resetToolCallDisplay: noop,
      revealAllAnswerText: noop, appendToolCallDisplay: noop, finishToolCallDisplay: noop,
      streamResponser: { partial: noop, endPartial: noop, stop: noop, getPlayEndPromise: async () => {} },
      transitionTo: state => { assert.equal(state, "sleep"); ctx.currentFlowName = state; completed(); },
    };
    exported.flowStates.answer(ctx);
    await completion;
  }
  try {
    if (variant === "trimmed") {
      for (let turn = 0; turn < 12; turn++) await ask(`Historical turn ${turn}: ${"context filler ".repeat(60)}`);
    }
    const question = variant === "explicit" ? explicit : automatic;
    await ask(question);
    const relevantRequests = requests.filter(request => request.question === question);
    const scoped = injections[injections.length - 1].input.filter(item => item.role === "system");
    const serialized = relevantRequests.map(request => request.raw);
    const toolResults = relevantRequests.flatMap(request => request.body.messages.filter(item => item.role === "tool"));
    const greeting = memory.prepareMemoryPrompt("Hello.");
    const unrelated = memory.prepareMemoryPrompt("Explain what DHCP does.");
    const repeated = memory.prepareMemoryPrompt(automatic);
    emit({
      loaded: prepared.includes("Copper Finch"), injected: scoped.some(item => item.content.includes("Copper Finch") && item.contextScope === "turn"),
      inEveryHttpRequest: serialized.length > 0 && serialized.every(raw => raw.includes("Copper Finch")),
      hostMarkerAbsent: serialized.every(raw => !raw.includes("contextScope")), requestCount: serialized.length,
      irrelevantExcluded: serialized.every(raw => !raw.includes("Obsidian")), greeting, unrelated,
      repeated: repeated.includes("Copper Finch"), bytesUnchanged: fs.readFileSync(storePath, "utf8") === before,
      offered: relevantRequests[0]?.body.tools?.some(tool => tool.function.name === "searchLocalMemory"),
      explicitResult: toolResults.some(item => item.tool_name === "searchLocalMemory" && item.content.includes("Copper Finch")),
      historyTrimmed: variant !== "trimmed" || !serialized[0].includes("Historical turn 0:"),
      firstQuestion: requests[0]?.body.messages.filter(item => item.role === "user")[0]?.content,
    });
  } finally {
    llm.cancelLLMRequest();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
