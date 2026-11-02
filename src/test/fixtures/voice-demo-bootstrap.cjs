// Live-backend demo isolation. Unlike isolate-tests.cjs, NO HTTP/model/metric mocks.
const fs = require('fs'), path = require('path');
const project = process.cwd();
const root = fs.mkdtempSync(path.join(project, '.voice-demo-'));
Object.assign(process.env, {
  LLM_SERVER: 'ollama', OLLAMA_ENDPOINT: 'http://127.0.0.1:11434',
  OLLAMA_MODEL: 'qwen3.5:2b-q4_K_M', OLLAMA_ENABLE_TOOLS: 'true', ENABLE_THINKING: 'false',
  OLLAMA_PREDICT_NUM: '180', ASSISTANT_PERSONA: 'glados', GLADOS_PERSONA_VARIANT: '',
  WHISPLAY_VOICE_CONTROL_ENABLED: 'true', WHISPLAY_DEVICE_ENABLED: 'false',
  WHISPLAY_WEB_ENABLED: 'false', WEB_AUDIO_ENABLED: 'false', WEB_CAMERA_ENABLED: 'false',
  MEMORY_ENABLED: 'false', MEMPALACE_ENABLED: 'false', ENABLE_RAG: 'false',
  WEB_SEARCH_ENABLED: 'false', IMAGE_GENERATION_SERVER: '', VISION_SERVER: '',
  WAKE_WORD_ENABLED: 'false', HARNESS_COMMAND_TOOL_ENABLED: 'false',
  HARDNESS_COMMAND_TOOL_ENABLED: 'false', MUSIC_LIBRARY_DIRS: '',
  CLEAN_DATA_FOLDER_ON_START: 'false', TEMP: root, TMP: root, TMPDIR: root,
});
const directories = {};
for (const key of ['dataDir','asrDir','ttsDir','recordingsDir','chatHistoryDir','imageDir','cameraDir','cameraFeedDir','knowledgeDir']) {
  const directory = path.join(root, key); fs.mkdirSync(directory); directories[key] = directory;
}
for (const [file, exports] of [['src/utils/dir.ts', directories], ['src/plugin/loader.ts', { loadExternalPlugins() {} }]]) {
  const filename=path.join(project,file);
  require.cache[filename]={ id:filename, filename, loaded:true, exports };
}
console.log('[Live demo] Data isolated at',root,'; real Ollama, real metrics, real RPC; no ASR/TTS/memory writes.');
