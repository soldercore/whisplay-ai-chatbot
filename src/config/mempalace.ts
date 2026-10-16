import { LLMTool, ToolReturnTag } from "../type";
import dotenv from "dotenv";
import { spawn } from "child_process";
import moment from "moment";
import { currentToolSignal, checkCancelled } from "../utils/operation-lifecycle";
import { StringDecoder } from "node:string_decoder";

dotenv.config();

const mempalaceEnabled = process.env.MEMPALACE_ENABLED === "true";
const mempalacePalacePath = process.env.MEMPALACE_PALACE_PATH || "";
const mempalacePythonPath = process.env.MEMPALACE_PYTHON_PATH || "python3";
const mempalaceMaxResults = parseInt(
  process.env.MEMPALACE_MAX_RESULTS || "5",
  10,
);
const mempalaceDefaultWing = process.env.MEMPALACE_DEFAULT_WING || "";
const mempalaceAutoSave =
  process.env.MEMPALACE_AUTO_SAVE !== "false" && mempalaceEnabled;

export const mempalaceTools: LLMTool[] = [];
let activeProcesses = 0;

// Only the fixed, host-owned MemPalace CLI/scripts below call this helper.
// No shell and no model-selected executable or Python source.
function runPythonCommand(args: string[], input = ""): Promise<string> {
  const signal = currentToolSignal();
  checkCancelled(signal);
  if (activeProcesses >= 2) return Promise.reject(new Error("MemPalace process limit reached"));
  activeProcesses++;
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try { proc = spawn(mempalacePythonPath, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    }); } catch (error) { activeProcesses--; reject(error); return; }
    let stdout = "", stderr = "", bytes = 0;
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    let failure: Error | undefined, finished = false;
    const stop = (error: Error) => {
      if (failure || finished) return;
      failure = error;
      // Linux child + descendants share this newly created process group.
      if (process.platform !== "win32" && proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL"); return; } catch {}
      }
      proc.kill("SIGKILL");
    };
    const abort = () => stop(new Error("MemPalace operation cancelled"));
    const timer = setTimeout(() => stop(new Error("MemPalace operation timed out")), 30_000);
    const complete = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      proc.stdout?.off("data", out); proc.stderr?.off("data", err);
      proc.stdin?.off("error", stdinError);
      proc.off("error", processError); proc.off("close", close);
      activeProcesses--;
      if (failure || error) reject(failure || error); else resolve(stdout + stdoutDecoder.end());
    };
    const collect = (data: Buffer, isError: boolean) => {
      if (failure) return;
      bytes += data.length;
      if (bytes > 512 * 1024) { stop(new Error("MemPalace output limit exceeded")); return; }
      if (isError) stderr += stderrDecoder.write(data); else stdout += stdoutDecoder.write(data);
    };
    const out = (data: Buffer) => collect(data, false), err = (data: Buffer) => collect(data, true);
    const stdinError = (error: Error) => stop(error);
    const processError = (error: Error) => complete(error);
    const close = (code: number | null) => complete(code === 0 ? undefined : new Error(stderr || `MemPalace exit code ${code}`));
    proc.stdout?.on("data", out); proc.stderr?.on("data", err);
    proc.stdin?.on("error", stdinError); proc.once("error", processError); proc.once("close", close);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!failure) proc.stdin?.end(input);
  });
}



/**
 * Run a mempalace CLI command and return stdout.
 */
function runMempalace(args: string[]): Promise<string> {
  const fullArgs = ["-m", "mempalace.cli", ...args];
  if (mempalacePalacePath) {
    fullArgs.push("--palace", mempalacePalacePath);
  }
  return runPythonCommand(fullArgs);
}

if (mempalaceEnabled) {
  console.log("[MemPalace] Enabled");

  // ── Search memories ───────────────────────────────────────
  mempalaceTools.push({
    execution: "abortable",
    type: "function",
    function: {
      name: "mempalaceSearch",
      description:
        "Search the user's long-term memory palace for past conversations, decisions, facts, and preferences. " +
        "Use this when the user asks about something that may have been discussed before, " +
        'or when context from previous sessions would help (e.g. "why did we choose X", ' +
        '"what did I say about Y last time").',
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The semantic search query to look up in memory",
          },
          wing: {
            type: "string",
            description:
              "Optional wing (person or project) to narrow the search scope",
          },
          room: {
            type: "string",
            description: "Optional room (topic) to narrow the search scope",
          },
        },
        required: ["query"],
      },
    },
    func: async (params: { query: string; wing?: string; room?: string }) => {
      try {
        const args = ["search", params.query];
        const wing = params.wing || mempalaceDefaultWing;
        if (wing) {
          args.push("--wing", wing);
        }
        if (params.room) {
          args.push("--room", params.room);
        }
        args.push("--top-k", String(mempalaceMaxResults));
        const result = await runMempalace(args);
        if (!result.trim()) {
          return `${ToolReturnTag.Success}No memories found for this query.`;
        }
        return `${ToolReturnTag.Success}${result.trim()}`;
      } catch (error: any) {
        console.error("[MemPalace] Search error:", error.message);
        return `${ToolReturnTag.Error}Failed to search memories: ${error.message}`;
      }
    },
  });

  // ── Store a memory ────────────────────────────────────────
  mempalaceTools.push({
    execution: "abortable",
    type: "function",
    function: {
      name: "mempalaceStore",
      description:
        "Store an important piece of information into the user's long-term memory palace. " +
        "Use this to save key decisions, preferences, facts, or insights that the user " +
        "may want to recall in future conversations.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The verbatim content to store (decision, preference, fact, etc.)",
          },
          wing: {
            type: "string",
            description:
              "The wing (person or project) to file this memory under",
          },
          room: {
            type: "string",
            description:
              "The room (topic) to file this memory under (e.g. auth-migration, preferences)",
          },
          hall: {
            type: "string",
            description:
              "The hall type: hall_facts, hall_events, hall_discoveries, hall_preferences, or hall_advice",
          },
        },
        required: ["content"],
      },
    },
    func: async (params: {
      content: string;
      wing?: string;
      room?: string;
      hall?: string;
    }) => {
      try {
        const result = await storeToMemPalace(params);
        return `${ToolReturnTag.Success}Memory stored successfully. ${result}`;
      } catch (error: any) {
        console.error("[MemPalace] Store error:", error.message);
        return `${ToolReturnTag.Error}Failed to store memory: ${error.message}`;
      }
    },
  });

  // ── Wake-up context ───────────────────────────────────────
  mempalaceTools.push({
    execution: "abortable",
    type: "function",
    function: {
      name: "mempalaceWakeUp",
      description:
        "Load the user's critical context from the memory palace (identity, key facts, preferences). " +
        "Use this at the start of a conversation or when the user asks you to remember who they are " +
        "or what projects they are working on.",
      parameters: {
        type: "object",
        properties: {
          wing: {
            type: "string",
            description:
              "Optional wing to get project-specific wake-up context",
          },
        },
      },
    },
    func: async (params: { wing?: string }) => {
      try {
        const args = ["wake-up"];
        const wing = params.wing || mempalaceDefaultWing;
        if (wing) {
          args.push("--wing", wing);
        }
        const result = await runMempalace(args);
        if (!result.trim()) {
          return `${ToolReturnTag.Success}No wake-up context configured yet. Run "mempalace init" to set up the palace.`;
        }
        return `${ToolReturnTag.Success}${result.trim()}`;
      } catch (error: any) {
        console.error("[MemPalace] Wake-up error:", error.message);
        return `${ToolReturnTag.Error}Failed to load wake-up context: ${error.message}`;
      }
    },
  });

  // ── Palace status ─────────────────────────────────────────
  mempalaceTools.push({
    execution: "abortable",
    type: "function",
    function: {
      name: "mempalaceStatus",
      description:
        "Get an overview of the user's memory palace: wings, rooms, memory counts, and storage stats.",
      parameters: {},
    },
    func: async () => {
      try {
        const result = await runMempalace(["status"]);
        return `${ToolReturnTag.Success}${result.trim()}`;
      } catch (error: any) {
        console.error("[MemPalace] Status error:", error.message);
        return `${ToolReturnTag.Error}Failed to get palace status: ${error.message}`;
      }
    },
  });
}

/**
 * Run a Python script via stdin — avoids shell injection from user content.
 */
function runPythonScript(script: string): Promise<string> {
  return runPythonCommand(["-c", script]);
}

/**
 * Store content to MemPalace using the Python API via stdin JSON.
 * Content is passed as a JSON object to avoid any injection issues.
 */
function storeToMemPalace(params: {
  content: string;
  wing?: string;
  room?: string;
  hall?: string;
}): Promise<string> {
  const payload = JSON.stringify({
    content: params.content,
    wing: params.wing || mempalaceDefaultWing || "wing_general",
    room: params.room || "general",
    hall: params.hall || "hall_events",
    palace_path: mempalacePalacePath || null,
  });

  // Python script reads JSON from stdin — no string embedding
  const script = `
import json, sys, os, uuid, time
data = json.loads(sys.stdin.read())
palace = data.get("palace_path") or os.path.expanduser("~/.mempalace/palace")
import chromadb
client = chromadb.PersistentClient(path=palace)
col = client.get_or_create_collection("mempalace_drawers")
doc_id = str(uuid.uuid4())
meta = {"wing": data["wing"], "room": data["room"], "hall": data["hall"], "timestamp": time.time()}
col.add(ids=[doc_id], documents=[data["content"]], metadatas=[meta])
print(f"Stored in {data['wing']}/{data['hall']}/{data['room']} (id={doc_id})")
`.trim();

  return runPythonCommand(["-c", script], payload).then(output => output.trim());
}

/**
 * Auto-save a completed user↔assistant exchange to MemPalace.
 * Runs in the background — errors are logged but never block the chat flow.
 */
export function autoSaveExchange(
  userText: string,
  assistantText: string,
): void {
  if (!mempalaceAutoSave) return;
  if (!userText.trim() || !assistantText.trim()) return;

  const ts = moment().format("YYYY-MM-DD HH:mm:ss");
  const content = `[${ts}]\nUser: ${userText}\nAssistant: ${assistantText}`;

  storeToMemPalace({
    content,
    wing: mempalaceDefaultWing || "wing_general",
    room: "conversations",
    hall: "hall_events",
  })
    .then((res) => console.log(`[MemPalace] Auto-saved exchange: ${res}`))
    .catch((err) =>
      console.error(`[MemPalace] Auto-save failed: ${err.message}`),
    );
}

export const addMemPalaceTools = (tools: LLMTool[]) => {
  if (mempalaceTools.length > 0) {
    console.log(
      `[MemPalace] Adding ${mempalaceTools.length} tool(s): ` +
        `${mempalaceTools.map((t) => t.function.name).join(", ")}`,
    );
    tools.push(...mempalaceTools);
  }
};
