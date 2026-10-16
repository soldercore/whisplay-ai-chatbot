import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual initializer, not the utils/dir replacement used by the
// application tests. Only this module runs; dotenv and application imports do not.
const project = path.resolve(__dirname, "../..");
const base = path.join(project, ".test-artifacts");
fs.mkdirSync(base, { recursive: true });
const suiteRoot = fs.mkdtempSync(path.join(base, "startup-data-"));
const source = fs.readFileSync(path.join(project, "src/utils/dir.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const files = [
  "data/memory/memory.json", "data/memory/memory.json.tmp",
  "data/memory/memory.json.bak-test", "data/memory/memory.json.corrupt-test",
  "data/chat_history/ollama_saved.json", "data/recordings/user-saved.wav",
  "data/tts/user-saved.wav", "data/tts/piper_http_1792022400000_123_1.wav",
  "data/tts/piper_http_1792022400000_123_1_converted.wav",
  "data/images/saved.png", "data/piper-service-backups/piper.service.txt",
  "data/plugin-private/settings.json", "data/unknown.bin", "data/user-notes.tmp",
  "plugins/fixture/.env", "skills/fixture/SKILL.md", "chatbot.log",
  ".env", ".env.backups/saved.env", "external-memory/memory.json", "knowledge/saved.txt",
];
const directoryNames: Record<string, string> = {
  dataDir: "data", asrDir: "data/asr", ttsDir: "data/tts",
  recordingsDir: "data/recordings", chatHistoryDir: "data/chat_history",
  imageDir: "data/images", cameraDir: "data/camera", cameraFeedDir: "data/camera_feed",
  knowledgeDir: "knowledge",
};

function fixture(populate = true): string {
  const root = fs.mkdtempSync(path.join(suiteRoot, "case-"));
  if (populate) for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(`fixture\0${relative}\n`));
  }
  return root;
}

function snapshot(root: string) {
  return files.map((relative) => {
    const file = path.join(root, relative);
    const stat = fs.statSync(file);
    return [relative, fs.readFileSync(file).toString("hex"), stat.size, stat.mtimeMs, stat.mode];
  });
}

function startup(root: string, flag: string | undefined, options: {
  layout?: "src" | "dist"; interrupt?: boolean; invalidPath?: boolean;
} = {}) {
  const warnings: string[] = [];
  const destructive: string[] = [];
  const checkPath = (file: fs.PathLike) => {
    assert.equal(typeof file, "string");
    const relative = path.relative(suiteRoot, path.resolve(file as string));
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "all filesystem calls must stay in this suite's disposable tree");
  };
  const filesystem = new Proxy({}, {
    get(_target, key) {
      if (key === "__esModule") return false;
      if (key === "existsSync") return (file: fs.PathLike) => {
        checkPath(file);
        return fs.existsSync(file);
      };
      if (key === "mkdirSync") return (file: fs.PathLike, mkdirOptions: fs.MakeDirectoryOptions) => {
        checkPath(file);
        const result = fs.mkdirSync(file, mkdirOptions);
        if (options.interrupt) {
          const error = Object.assign(new Error("Injected startup interruption"), { code: "EIO" });
          throw error;
        }
        return result;
      };
      // Deny before execution: a future regression cannot delete even fixtures.
      return (..._args: unknown[]) => {
        destructive.push(String(key));
        throw new Error(`Startup must not call fs.${String(key)}`);
      };
    },
  });
  const exported: Record<string, string> = {};
  let error: unknown;
  try {
    vm.runInNewContext(compiled, {
      exports: exported,
      __dirname: path.join(root, ...(options.invalidPath ? ["bad\0path"] : []), options.layout || "src", "utils"),
      process: { env: flag === undefined ? {} : { CLEAN_DATA_FOLDER_ON_START: flag } },
      console: { warn: (message: string) => warnings.push(message), log() {} },
      require(name: string) {
        if (name === "fs") return filesystem;
        if (name === "path") return path;
        if (name === "dotenv") return { config() {} };
        throw new Error(`Unexpected initializer dependency: ${name}`);
      },
    }, { timeout: 1000, filename: "isolated-utils-dir.js" });
  } catch (caught) { error = caught; }
  return { warnings, destructive, exported, error };
}

for (const flag of ["true", "false", undefined]) for (const layout of ["src", "dist"] as const) {
  test(`${layout} startup preserves every persistent file with cleanup=${String(flag)}`, () => {
    const root = fixture();
    const before = snapshot(root);
    const result = startup(root, flag, { layout });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.destructive, []);
    assert.deepEqual(snapshot(root), before);
    assert.equal(result.warnings.length, flag === "true" ? 1 : 0);
    if (flag === "true") assert.match(result.warnings[0], /CLEAN_DATA_FOLDER_ON_START.*ignored.*deletion is disabled/);
    for (const [name, relative] of Object.entries(directoryNames)) {
      assert.equal(result.exported[name], path.join(root, relative));
      assert.equal(fs.statSync(result.exported[name]).isDirectory(), true);
    }
    assert.deepEqual(Object.keys(result.exported).sort(), Object.keys(directoryNames).sort());
  });
}

for (const flag of ["true", "false"]) {
  test(`repeated startups preserve old and newly saved files with cleanup=${flag}`, () => {
    const root = fixture();
    const before = snapshot(root);
    assert.equal(startup(root, flag).error, undefined);
    const newFile = path.join(root, "data/recordings/saved-between-starts.wav");
    fs.writeFileSync(newFile, "new user recording");
    for (let index = 0; index < 3; index++) {
      const result = startup(root, flag);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.destructive, []);
      assert.deepEqual(snapshot(root), before);
      assert.equal(fs.readFileSync(newFile, "utf8"), "new user recording");
    }
  });

  test(`missing directories are created with cleanup=${flag}`, () => {
    const root = fixture(false);
    const result = startup(root, flag);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.destructive, []);
    for (const relative of Object.values(directoryNames)) assert.ok(fs.statSync(path.join(root, relative)).isDirectory());
  });

  test(`interrupted initialization preserves persistent data and can retry with cleanup=${flag}`, () => {
    const root = fixture();
    const before = snapshot(root);
    const result = startup(root, flag, { interrupt: true });
    assert.equal((result.error as NodeJS.ErrnoException)?.code, "EIO");
    assert.deepEqual(result.destructive, []);
    assert.deepEqual(snapshot(root), before);
    assert.equal(startup(root, flag).error, undefined);
    assert.deepEqual(snapshot(root), before);
  });

  test(`invalid module paths fail without deleting files with cleanup=${flag}`, () => {
    const root = fixture();
    const before = snapshot(root);
    const result = startup(root, flag, { invalidPath: true });
    assert.match(String(result.error), /null bytes/);
    assert.deepEqual(result.destructive, []);
    assert.deepEqual(snapshot(root), before);
  });

  test(`directory links outside data preserve their targets with cleanup=${flag}`, () => {
    for (const relative of ["data", "data/tts"]) {
      const root = fixture(false);
      const target = path.join(root, "outside-data");
      fs.mkdirSync(target);
      const sentinel = path.join(target, "user-saved.wav");
      fs.writeFileSync(sentinel, "persistent linked file");
      const link = path.join(root, relative);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, "junction");
      const result = startup(root, flag);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.destructive, []);
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.equal(fs.readFileSync(sentinel, "utf8"), "persistent linked file");
    }
  });
}

test("path-like flag values cannot supply a deletion target", () => {
  const root = fixture();
  const before = snapshot(root);
  for (const flag of ["../memory", path.join(root, "data"), "TRUE", "true\n"]) {
    const result = startup(root, flag);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.destructive, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(snapshot(root), before);
  }
});
