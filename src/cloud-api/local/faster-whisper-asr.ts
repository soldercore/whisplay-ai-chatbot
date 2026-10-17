import axios from "axios";
import dotenv from "dotenv";
import { readFileSync } from "fs";

dotenv.config();

const fasterWhisperPort = process.env.FASTER_WHISPER_PORT || "8803";
const fasterWhisperHost = process.env.FASTER_WHISPER_HOST || "localhost";
const fasterWhisperLanguage = process.env.FASTER_WHISPER_LANGUAGE || "en";
const fasterWhisperInitialPrompt = process.env.FASTER_WHISPER_INITIAL_PROMPT?.trim();
const fasterWhisperRequestType =
  process.env.FASTER_WHISPER_REQUEST_TYPE || "filePath";

// Server startup/ownership is handled before providers load in index.ts.

interface FasterWhisperResponse {
  filePath: string;
  recognition: string;
}

export const recognizeAudio = async (
  audioFilePath: string
): Promise<string> => {
  const body: { filePath?: string; base64?: string; language?: string; initial_prompt?: string } = {};
  body.language = fasterWhisperLanguage;
  if (fasterWhisperInitialPrompt) body.initial_prompt = fasterWhisperInitialPrompt;
  if (fasterWhisperRequestType === "filePath") {
    body.filePath = audioFilePath;
  } else if (fasterWhisperRequestType === "base64") {
    const audioData = readFileSync(audioFilePath);
    const base64Audio = audioData.toString("base64");
    body.base64 = base64Audio;
  } else {
    console.error(
      `Invalid FASTER_WHISPER_REQUEST_TYPE: ${fasterWhisperRequestType}, defaulting to filePath`
    );
    body.filePath = audioFilePath;
  }
  return axios
    .post<FasterWhisperResponse>(
      `http://${fasterWhisperHost}:${fasterWhisperPort}/recognize`,
      body
    )
    .then((response) => {
      if (response.data && response.data.recognition) {
        return response.data.recognition;
      } else {
        console.error("Invalid response from Whisper service:", response.data);
        return "";
      }
    })
    .catch((error) => {
      console.error("Error calling Whisper service:", error);
      return "";
    })
};
