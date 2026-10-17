// Offline plan by default. --run is an explicit, loopback-only generation test.
// No application import, tool dispatch, speech, stored history or data writes.
const fs = require("node:fs");
const axios = require("axios");
const fixture = require("../src/test/fixtures/persona-consistency.json");
const { personaPrompt } = require("../src/config/persona");
const { promptMessageTokens, fitOllamaPrompt } = require("../src/cloud-api/local/ollama-context-budget");
const { readOllamaNDJSON } = require("../src/cloud-api/local/ollama-ndjson");

const candidate = [fixture.candidateInstructions, fixture.exampleInstruction,
  ...fixture.examples.map(example => `User: ${example.user}\nAssistant: ${example.assistant}`),
  "End of fictional tone examples.\n"].join("\n\n");
const production = personaPrompt({ ASSISTANT_PERSONA: "glados" });
// Evaluation only: retain A's delivery and factual/safety rules; no examples
// that could become catchphrases or answers keyed to the evaluation questions.
const candidateC = production
  .replace("Never explain a joke.", "Never explain a joke. On humans, make one dry observation, not a verdict on humanity.")
  .replace("Greetings: one short sentence.", "Greetings: one short sentence, then stop.")
  .replace("facts about the user or observations", "facts about the user, personal experiences or observations")
  .replace("Never call yourself an AI language model.",
    "No unsolicited disclaimers about being AI, code or lacking feelings. Answer direct identity questions honestly and briefly.");
const prefixes = { A: production, B: candidate, C: candidateC };
const quiet = work => { const log = console.log; console.log = () => {}; try { return work(); } finally { console.log = log; } };

function settings(env) {
  if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== fixture.model) throw Error("Configured model differs from required comparison model");
  const options = { temperature: 0.7 };
  if (env.OLLAMA_PREDICT_NUM) {
    const n = Number(env.OLLAMA_PREDICT_NUM);
    if (!Number.isSafeInteger(n) || n === 0 || n < -2) throw Error("Invalid OLLAMA_PREDICT_NUM");
    options.num_predict = n;
  }
  return { model: fixture.model, think: env.ENABLE_THINKING === "true", stream: true, options, keep_alive: -1 };
}

function buildMessages(variant, scenario, history, suffix = "", webNote = "", temperature = null) {
  if (!Object.hasOwn(prefixes, variant)) throw Error("Unknown comparison variant");
  const messages = [{ role: "system", content: prefixes[variant] + suffix + webNote }];
  if (scenario.context) messages.push({ role: "system", content: scenario.context });
  messages.push(...history.map(message => ({ ...message })));
  if (scenario.tool && history.length === 1) {
    const name = scenario.tool === "temperature" ? "getSystemHealth" : "web_search";
    const output = scenario.tool === "temperature"
      ? `[success]${JSON.stringify({ cpu: { temperature: temperature }, healthAssessment: "not_assessed" })}`
      : "[error]Search provider unavailable. No current weather information was retrieved.";
    messages.push({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: {} } }] },
      { role: "tool", tool_name: name, content: output });
  }
  return messages;
}

function requestFor(messages, generation) {
  const fitted = quiet(() => fitOllamaPrompt(messages, undefined, { effective: 4096, source: "/api/ps" }, undefined,
    generation.options.num_predict));
  if (fitted.messages.length !== messages.length) throw Error("Evaluation would trim context; comparison refused");
  return { ...generation, messages };
}

// Sample once for both variants. Missing/non-CPU metrics remain unavailable.
function readTemperature() {
  try {
    const type = fs.readFileSync("/sys/class/thermal/thermal_zone0/type", "utf8").trim();
    const text = fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim();
    if (!/cpu|soc/i.test(type) || !/^\d+$/.test(text)) return null;
    const value = Number(text) / 1000;
    return Number.isFinite(value) ? { value, unit: "°C" } : null;
  } catch { return null; }
}

function assertRuntime(data) {
  const models = Array.isArray(data?.models) ? data.models : [];
  const target = models.filter(model => model.name === fixture.model || model.model === fixture.model);
  if (target.length !== 1 || target[0].context_length !== 4096)
    throw Error("Required Qwen model must already be loaded with context_length=4096; nothing was loaded or reconfigured");
}

async function generate(request, signal) {
  const response = await axios.post("http://127.0.0.1:11434/api/chat", request,
    { signal, proxy: false, responseType: "stream", maxRedirects: 0 });
  let content = "", thinking = "", tools = [], done;
  await readOllamaNDJSON(response.data, record => {
    content += record.message?.content || ""; thinking += record.message?.thinking || "";
    tools.push(...(record.message?.tool_calls || []));
    if (Buffer.byteLength(content + thinking) > 262144) throw Error("Evaluation output exceeds 256 KiB");
    if (record.done === true) done = record;
  }, undefined, signal);
  if (!content.trim() || tools.length || done?.done_reason === "length") throw Error("Unusable answer: empty, tool proposal, or output truncated");
  return { content, thinking, completion: done.done_reason || "done", prompt_eval_count: done.prompt_eval_count,
    prompt_eval_duration: done.prompt_eval_duration, eval_count: done.eval_count, eval_duration: done.eval_duration };
}

async function compare({ generation, suffix, webNote, temperature, challenger = "B", repetitions = 3, generateAnswer = generate, emit }) {
  if (!["B", "C"].includes(challenger)) throw Error("Use comparison candidate B or C");
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const scenario of fixture.scenarios) {
      // Alternate order to reduce systematic first/second cache bias. Histories
      // belong to one variant/scenario/replicate; no previous job is reused.
      for (const variant of repeat % 2 ? [challenger, "A"] : ["A", challenger]) {
        const history = (scenario.prior || []).map(message => ({ ...message }));
        for (let turn = 0; turn < scenario.turns.length; turn++) {
          history.push({ role: "user", content: scenario.turns[turn] });
          const request = requestFor(buildMessages(variant, scenario, history, suffix, webNote, temperature), generation);
          const started = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("Evaluation request timed out")), 7200000);
          try {
            const answer = await generateAnswer(request, controller.signal);
            history.push({ role: "assistant", content: answer.content });
            emit({ variant, repeat: repeat + 1, scenario: scenario.id, turn: turn + 1, request, answer,
              elapsedMs: Date.now() - started, criterion: scenario.criterion,
              exactExampleReuse: fixture.examples.some(example => answer.content.includes(example.assistant)),
              scores: Object.fromEntries(fixture.dimensions.map(dimension => [dimension, null])) });
          } finally { clearTimeout(timer); }
        }
      }
    }
  }
}

async function main(args) {
  const challenger = args.includes("--candidate=C") ? "C" : "B";
  args = args.filter(arg => arg !== "--candidate=C");
  if (args.length > 1 || (args.length && !["--plan", "--run"].includes(args[0]))) throw Error("Use --plan (default) or --run");
  // Reuse only the existing pure prompt assembly. Never import the Ollama
  // provider, registry, memory store, directory initializer or hardware modules.
  process.env.ASSISTANT_PERSONA = "glados";
  const assembled = quiet(() => require("../src/config/llm-config").systemPrompt);
  if (!assembled.startsWith(production)) throw Error("Production prompt prefix differs; inspect before comparing");
  const suffix = assembled.slice(production.length);
  const webNote = process.env.OLLAMA_ENABLE_TOOLS === "true"
    ? quiet(() => require("../src/config/web-search").getWebSearchSystemNote(new Date())) : "";
  const generation = settings(process.env);
  const measure = prompt => ({ characters: prompt.length, estimatedTokens: promptMessageTokens({ role: "system", content: prompt }) });
  console.log(JSON.stringify({ kind: "plan", generation, A: measure(production), [challenger]: measure(prefixes[challenger]),
    prompts: { A: production + suffix + webNote, [challenger]: prefixes[challenger] + suffix + webNote },
    scenarios: fixture.scenarios, repetitions: 3, dimensions: fixture.dimensions,
    limits: "Text-only, no tools offered/executed; tool results and memory are fixtures. No production routing/authorization or subjective quality proof." }));
  if (args[0] !== "--run") return;
  const runtime = await axios.get("http://127.0.0.1:11434/api/ps", { timeout: 3000, proxy: false, maxRedirects: 0, maxContentLength: 65536 });
  assertRuntime(runtime.data);
  const temperature = readTemperature();
  console.log(JSON.stringify({ kind: "host_sample", sampledAt: new Date().toISOString(), temperature }));
  await compare({ generation, suffix, webNote, temperature, challenger, emit: record => console.log(JSON.stringify(record)) });
}

module.exports = { fixture, production, candidate, candidateC, settings, buildMessages, requestFor, assertRuntime, generate, compare };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
