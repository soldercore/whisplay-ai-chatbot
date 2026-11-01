// Offline plan by default. --run is an explicit, loopback-only generation test.
// No application import, tool dispatch, speech, stored history or data writes.
const fs = require("node:fs");
const axios = require("axios");
const fixture = require("../src/test/fixtures/persona-consistency.json");
const continuity = require("../src/test/fixtures/persona-continuity.json");
const piRegression = require("../src/test/fixtures/glados-d-pi-regression.json");
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
const candidateD = personaPrompt({ ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: "D" });
const prefixes = { A: production, B: candidate, C: candidateC, D: candidateD, D0: piRegression.repository_reference.prefix };
const piScenarios = [
  { id: "pi_conversation", turns: piRegression.exchanges.map(x => x.user),
    criterion: "Exact reported user turns with newly generated answers; judge apology, achievement, relevance, wit and nonfabrication, not just missing phrases." },
  ...piRegression.exchanges.map((x, i) => ({ id: `pi_fresh_${i + 1}`, turns: [x.user],
    criterion: "Fresh history: concise situational wit, honest facts and no hostility or unsupported history." })),
  { id: "pi_apology_recovery", prior: piRegression.exchanges.slice(0, 2).flatMap(x =>
    [{ role: "user", content: x.user }, { role: "assistant", content: x.assistant }]),
    turns: [piRegression.exchanges[2].user],
    criterion: "Accept the exact apology despite the same two recorded hostile answers; do not reject it or continue their fictional circumstances." },
];
const availableScenarios = [...fixture.scenarios, ...continuity.scenarios, ...piScenarios];
const quiet = work => { const log = console.log; console.log = () => {}; try { return work(); } finally { console.log = log; } };

function endpointFor(env) {
  const url = new URL(env.OLLAMA_ENDPOINT || "http://127.0.0.1:11434");
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw Error("Evaluation requires a loopback-only Ollama endpoint without credentials, path or redirects");
  return url.origin;
}

function settings(env, sampling = {}) {
  if (env.OLLAMA_MODEL && env.OLLAMA_MODEL !== fixture.model) throw Error("Configured model differs from required comparison model");
  const options = { temperature: 0.7 };
  if (env.OLLAMA_PREDICT_NUM) {
    const n = Number(env.OLLAMA_PREDICT_NUM);
    if (!Number.isSafeInteger(n) || n === 0 || n < -2) throw Error("Invalid OLLAMA_PREDICT_NUM");
    options.num_predict = n;
  }
  // Explicit evaluation-only overrides. Never read by the application's provider.
  for (const [name, value] of Object.entries(sampling)) {
    const valid = name === "seed" ? Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
      : name === "top_p" ? Number.isFinite(value) && value > 0 && value <= 1
      : ["temperature", "presence_penalty"].includes(name) && Number.isFinite(value) && value >= 0 && value <= 2;
    if (!valid) throw Error("Invalid evaluation sampling override");
    options[name] = value;
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

function requestFor(messages, generation, productionHistoryBudget = false) {
  const fitted = quiet(() => fitOllamaPrompt(messages, undefined, { effective: 4096, source: "/api/ps" }, undefined,
    generation.options.num_predict));
  if (!productionHistoryBudget && fitted.messages.length !== messages.length) throw Error("Evaluation would trim context; comparison refused");
  return { ...generation, messages: fitted.messages };
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

async function generate(request, signal, endpoint = "http://127.0.0.1:11434") {
  const origin = endpointFor({ OLLAMA_ENDPOINT: endpoint });
  const started = performance.now();
  let firstContentMs;
  const response = await axios.post(`${origin}/api/chat`, request,
    { signal, proxy: false, responseType: "stream", maxRedirects: 0 });
  let content = "", thinking = "", tools = [], done;
  await readOllamaNDJSON(response.data, record => {
    if (firstContentMs === undefined && record.message?.content) firstContentMs = performance.now() - started;
    content += record.message?.content || ""; thinking += record.message?.thinking || "";
    tools.push(...(record.message?.tool_calls || []));
    if (Buffer.byteLength(content + thinking) > 262144) throw Error("Evaluation output exceeds 256 KiB");
    if (record.done === true) done = record;
  }, undefined, signal);
  if (!content.trim() || tools.length || done?.done_reason === "length") throw Error("Unusable answer: empty, tool proposal, or output truncated");
  return { content, thinking, completion: done.done_reason || "done", prompt_eval_count: done.prompt_eval_count,
    prompt_eval_duration: done.prompt_eval_duration, eval_count: done.eval_count, eval_duration: done.eval_duration,
    firstContentMs, total_duration: done.total_duration, load_duration: done.load_duration };
}

async function compare({ generation, suffix, webNote, temperature, challenger = "B", repetitions = 3,
  scenarios = fixture.scenarios, baseline = "A", productionHistoryBudget = false, generateAnswer = generate, emit }) {
  if (!["B", "C", "D"].includes(challenger)) throw Error("Use comparison candidate B, C or D");
  if (!["A", "D0"].includes(baseline)) throw Error("Use baseline A or the frozen hardware-reference D0");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw Error("Use one to three repetitions");
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const scenario of scenarios) {
      // Alternate order to reduce systematic first/second cache bias. Histories
      // belong to one variant/scenario/replicate; no previous job is reused.
      for (const variant of repeat % 2 ? [challenger, baseline] : [baseline, challenger]) {
        const history = (scenario.prior || []).map(message => ({ ...message }));
        for (let turn = 0; turn < scenario.turns.length; turn++) {
          history.push({ role: "user", content: scenario.turns[turn] });
          const inputs = buildMessages(variant, scenario, history, suffix, webNote, temperature);
          const request = requestFor(inputs, generation, productionHistoryBudget);
          const started = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("Evaluation request timed out")), 7200000);
          try {
            const answer = await generateAnswer(request, controller.signal);
            history.push({ role: "assistant", content: answer.content });
            emit({ variant, repeat: repeat + 1, scenario: scenario.id, turn: turn + 1, request, answer,
              trimmedMessages: inputs.length - request.messages.length,
              elapsedMs: Date.now() - started, criterion: scenario.criterion,
              exactExampleReuse: fixture.examples.some(example => answer.content.includes(example.assistant)),
              scores: Object.fromEntries(fixture.dimensions.map(dimension => [dimension, null])) });
          } finally { clearTimeout(timer); }
        }
      }
    }
  }
}

function parseArgs(args) {
  const result = { mode: "--plan", challenger: "B", baseline: "A", repetitions: 3,
    scenarios: fixture.scenarios, sampling: {}, productionHistoryBudget: false };
  const seen = new Set();
  for (const arg of args) {
    const key = ["--plan", "--run"].includes(arg) ? "mode" : arg.split("=")[0];
    if (seen.has(key)) throw Error(`Duplicate option: ${key}`);
    seen.add(key);
    if (key === "mode") result.mode = arg;
    else if (/^--candidate=[BCD]$/.test(arg)) result.challenger = arg.slice(-1);
    else if (/^--baseline=(A|D0)$/.test(arg)) result.baseline = arg.slice("--baseline=".length);
    else if (arg === "--production-history-budget") result.productionHistoryBudget = true;
    else if (/^--(temperature|presence-penalty|top-p|seed)=/.test(arg)) {
      const [flag, text] = arg.split("=");
      if (!text || arg.split("=").length !== 2) throw Error("Invalid evaluation sampling override");
      result.sampling[flag.slice(2).replace("-", "_")] = Number(text);
    }
    else if (/^--repetitions=[123]$/.test(arg)) result.repetitions = Number(arg.slice(-1));
    else if (arg.startsWith("--scenarios=")) {
      const ids = arg.slice("--scenarios=".length).split(",");
      if (new Set(ids).size !== ids.length || ids.some(id => !availableScenarios.some(s => s.id === id)))
        throw Error("Unknown or duplicate scenario; inspect the plan's availableScenarios");
      result.scenarios = ids.map(id => availableScenarios.find(s => s.id === id));
    } else throw Error("Use --plan/--run, --candidate=B|C|D, --baseline=A|D0, --repetitions=1|2|3, --scenarios=id,id; sampling overrides are evaluation-only");
  }
  settings({}, result.sampling); // Validate without network or application imports.
  return result;
}

async function main(args) {
  const { mode, challenger, baseline, repetitions, scenarios, sampling, productionHistoryBudget } = parseArgs(args);
  // Reuse only the existing pure prompt assembly. Never import the Ollama
  // provider, registry, memory store, directory initializer or hardware modules.
  process.env.ASSISTANT_PERSONA = "glados";
  // An inherited D selection must not turn the A control into another D run.
  process.env.GLADOS_PERSONA_VARIANT = "A";
  const assembled = quiet(() => require("../src/config/llm-config").systemPrompt);
  if (!assembled.startsWith(production)) throw Error("Production prompt prefix differs; inspect before comparing");
  const suffix = assembled.slice(production.length);
  const webNote = process.env.OLLAMA_ENABLE_TOOLS === "true"
    ? quiet(() => require("../src/config/web-search").getWebSearchSystemNote(new Date())) : "";
  const generation = settings(process.env, sampling);
  const endpoint = endpointFor(process.env);
  const measure = prompt => ({ characters: prompt.length, estimatedTokens: promptMessageTokens({ role: "system", content: prompt }) });
  console.log(JSON.stringify({ kind: "plan", generation, endpoint, [baseline]: measure(prefixes[baseline]), [challenger]: measure(prefixes[challenger]),
    prompts: { [baseline]: prefixes[baseline] + suffix + webNote, [challenger]: prefixes[challenger] + suffix + webNote },
    baseline, samplingOverrides: sampling, productionHistoryBudget,
    scenarios, availableScenarios: availableScenarios.map(s => s.id), repetitions,
    generationRequests: scenarios.reduce((n, s) => n + s.turns.length, 0) * 2 * repetitions,
    configuration: { modelExplicit: !!process.env.OLLAMA_MODEL,
      thinkingExplicit: ["true", "false"].includes(process.env.ENABLE_THINKING) },
    dimensions: fixture.dimensions,
    limits: "Text-only, no tools offered/executed; tool results and memory are fixtures. No production routing/authorization or subjective quality proof." }));
  if (mode !== "--run") return;
  if (!process.env.OLLAMA_MODEL || !["true", "false"].includes(process.env.ENABLE_THINKING))
    throw Error("Before --run, confirm OLLAMA_MODEL and ENABLE_THINKING=true|false; historical defaults are not verified production settings");
  const runtime = await axios.get(`${endpoint}/api/ps`, { timeout: 3000, proxy: false, maxRedirects: 0, maxContentLength: 65536 });
  assertRuntime(runtime.data);
  const temperature = readTemperature();
  console.log(JSON.stringify({ kind: "host_sample", sampledAt: new Date().toISOString(), temperature }));
  await compare({ generation, suffix, webNote, temperature, challenger, baseline, repetitions, scenarios, productionHistoryBudget,
    generateAnswer: (request, signal) => generate(request, signal, endpoint), emit: record => console.log(JSON.stringify(record)) });
}

module.exports = { fixture, piRegression, production, candidate, candidateC, candidateD, availableScenarios, parseArgs, endpointFor,
  settings, buildMessages, requestFor, assertRuntime, generate, compare };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
