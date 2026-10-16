// Preload before test modules: never import the production data cleanup module
// or external plugins. Every generated file (including os.tmpdir()) stays here.
const fs = require("fs");
const path = require("path");
const project = path.resolve(__dirname, "../../..");
const base = path.join(project, ".test-artifacts");
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, "run-"));
if (process.env.WHISPLAY_TEST_ISOLATED !== "1") Object.assign(process.env, {
  CLEAN_DATA_FOLDER_ON_START: "false",
  ASR_SERVER: "test", TTS_SERVER: "test", LLM_SERVER: "test",
  MEMORY_ENABLED: "false", MEMPALACE_ENABLED: "false", ENABLE_RAG: "false",
  ENABLE_CAMERA: "false", VISION_SERVER: "", IMAGE_GENERATION_SERVER: "",
  MUSIC_LIBRARY_DIRS: "", WAKE_WORD_ENABLED: "false",
  HARNESS_COMMAND_TOOL_ENABLED: "false", HARDNESS_COMMAND_TOOL_ENABLED: "false",
  WHISPLAY_DEVICE_ENABLED: "false", WHISPLAY_WEB_ENABLED: "false",
  WEB_AUDIO_ENABLED: "false", WEB_CAMERA_ENABLED: "false",
});
Object.assign(process.env, {
  TEMP: root, TMP: root, TMPDIR: root, CLEAN_DATA_FOLDER_ON_START: "false",
  WHISPLAY_TEST_ISOLATED: "1",
});
// Explicit Node subprocesses in the older tests inherit the same isolation.
if (!(process.env.NODE_OPTIONS || "").includes(__filename)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --require ${JSON.stringify(__filename)}`.trim();
}
const directories = {};
for (const key of ["dataDir", "asrDir", "ttsDir", "recordingsDir", "chatHistoryDir", "imageDir", "cameraDir", "cameraFeedDir", "knowledgeDir"]) {
  const directory = path.join(root, key);
  fs.mkdirSync(directory);
  directories[key] = directory;
}
for (const [file, exports] of [
  ["src/utils/dir.ts", directories],
  ["src/plugin/loader.ts", { loadExternalPlugins() {} }],
]) {
  const filename = path.join(project, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
