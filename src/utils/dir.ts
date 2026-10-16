import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

function ensureDirExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export const dataDir = path.join(__dirname, "../..", "data");
if (process.env.CLEAN_DATA_FOLDER_ON_START === "true") {
  console.warn(
    "[Startup] CLEAN_DATA_FOLDER_ON_START is ignored; automatic data deletion is disabled.",
  );
}

ensureDirExists(dataDir);

export const asrDir = path.join(dataDir, "asr");
ensureDirExists(asrDir);

export const ttsDir = path.join(dataDir, "tts");
ensureDirExists(ttsDir);

export const recordingsDir = path.join(dataDir, "recordings");
ensureDirExists(recordingsDir);

export const chatHistoryDir = path.join(dataDir, "chat_history");
ensureDirExists(chatHistoryDir);

export const imageDir = path.join(dataDir, "images");
ensureDirExists(imageDir);

export const cameraDir = path.join(dataDir, "camera");
ensureDirExists(cameraDir);

export const cameraFeedDir = path.join(dataDir, "camera_feed");
ensureDirExists(cameraFeedDir);


export const knowledgeDir = path.join(__dirname, "../..", "knowledge");
ensureDirExists(knowledgeDir);
