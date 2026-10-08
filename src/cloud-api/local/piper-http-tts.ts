import * as fs from "fs";
import * as path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";
import { ChildProcess, spawn } from "child_process";
import dotenv from "dotenv";
import { ttsDir } from "../../utils/dir";
import { TTSResult, TTSServer } from "../../type";
import { defaultPortMap } from "./common";

dotenv.config();

const piperHttpHost = process.env.PIPER_HTTP_HOST || "localhost";
const piperHttpPort = process.env.PIPER_HTTP_PORT || defaultPortMap.piperHttp.toString();
const piperHttpModel =
  process.env.PIPER_HTTP_MODEL || "en_US-amy-medium";
const piperHttpLengthScale =
  process.env.PIPER_HTTP_LENGTH_SCALE || "1";
// Upper bound for one synthesis request, so a stalled Piper server cannot
// block the playback queue forever.
const piperHttpTimeoutSec = process.env.PIPER_HTTP_TIMEOUT_SEC || "60";
const piperHttpUrl = `http://${piperHttpHost}:${piperHttpPort}`;

const ttsServer = (process.env.TTS_SERVER || "").toLowerCase();

// TEMPORARY (Phase 0 TTS diagnostics): remove the [TTS-DIAG] lines once the
// audio path is confirmed on the device.
console.log(`[TTS-DIAG][piper-http] endpoint ${piperHttpUrl}, timeout ${piperHttpTimeoutSec}s`);

let pyProcess: ChildProcess | null = null;
if (ttsServer === TTSServer.piperhttp) {
  if (
    ["localhost", "0.0.0.0", "127.0.0.1"].includes(piperHttpHost)
  ) {
    console.log("Starting Piper HTTP server at port", piperHttpPort);
    // python3 -m piper.http_server -m en_US-lessac-medium
    pyProcess = spawn(
      "python3",
      [
        "-m",
        "piper.http_server",
        "-m",
        piperHttpModel,
        "--port",
        piperHttpPort,
        "--host",
        piperHttpHost,
      ],
      {
        detached: true,
        stdio: "inherit",
      }
    );
    pyProcess.on("error", (error) => {
      console.error("Failed to start the embedded Piper HTTP server:", error.message);
    });
    pyProcess.on("exit", (code, signal) => {
      // Exits right away when another Piper server already owns the port.
      console.log(
        `[TTS-DIAG][piper-http] embedded Piper HTTP server exited (code ${code}, signal ${signal})`
      );
    });
  }
}

let requestSeq = 0;
const PREVIEW_BYTES = 200;

const readPreview = (file: string): string => {
  try {
    const buffer = fs.readFileSync(file).subarray(0, PREVIEW_BYTES);
    return buffer.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  } catch {
    return "";
  }
};

const isWavFile = (file: string): boolean => {
  try {
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return (
      read === 12 &&
      header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  }
};

const removeFile = (file: string): void => {
  try {
    fs.unlinkSync(file);
  } catch {}
};

const piperHttpTTS = async (
  text: string
): Promise<TTSResult> => {
  return new Promise((resolve, reject) => {
    // Several sentences can start synthesizing in the same millisecond, so the
    // file name also carries a per-process sequence number.
    const id = `${Date.now()}_${process.pid}_${++requestSeq}`;
    const tempWavFile = path.join(ttsDir, `piper_http_${id}.wav`);
    const convertedWavFile = path.join(ttsDir, `piper_http_${id}_converted.wav`);

    // curl -X POST -H 'Content-Type: application/json' -d '{ "text": "This is a test." }' -o test.wav localhost:8805
    const body = JSON.stringify({
      text,
      length_scale: Number(piperHttpLengthScale),
    });

    const piperProcess = spawn(
      "curl",
      [
        "-sS",
        "--connect-timeout",
        "5",
        "--max-time",
        piperHttpTimeoutSec,
        "-w",
        "%{http_code} %{size_download} %{content_type}",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
        "-o",
        tempWavFile,
        piperHttpUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let curlOut = "";
    let curlErr = "";
    piperProcess.stdout?.on("data", (data) => (curlOut += data.toString()));
    piperProcess.stderr?.on("data", (data) => (curlErr += data.toString()));

    piperProcess.on("close", async (code: number) => {
      const [httpStatus = "", bytes = "", contentType = ""] = curlOut.trim().split(" ");
      console.log(
        `[TTS-DIAG][piper-http] POST ${piperHttpUrl} -> curl exit ${code}, HTTP ${httpStatus || "-"}, ${bytes || 0} bytes, ${contentType || "no content type"}`
      );

      if (code !== 0) {
        console.error(
          `Piper process exited with code ${code}${curlErr.trim() ? `: ${curlErr.trim()}` : ""}`
        );
        removeFile(tempWavFile);
        resolve({ duration: 0 });
        return;
      }

      if (fs.existsSync(tempWavFile) === false) {
        console.log("Piper output file not found:", tempWavFile);
        resolve({ duration: 0 });
        return;
      }

      if (httpStatus !== "200" || !isWavFile(tempWavFile)) {
        // Never hand an HTTP error body to SoX as if it were audio.
        console.error(
          `Piper returned no WAV audio (HTTP ${httpStatus}, ${contentType || "no content type"}): ${readPreview(tempWavFile)}`
        );
        removeFile(tempWavFile);
        resolve({ duration: 0 });
        return;
      }

      try {
        // The Whisplay ES8389 ALSA device rejects Piper's 22050 Hz mono output
        // when opened directly through hw:*, so normalize to the codec format.
        await new Promise<void>((res, rej) => {
          const soxProcess = spawn("sox", [
            "-v",
            "0.9",
            tempWavFile,
            "-r",
            "48000",
            "-c",
            "2",
            "-b",
            "16",
            convertedWavFile,
          ]);

          let soxErr = "";
          soxProcess.stderr?.on("data", (data) => (soxErr += data.toString()));
          soxProcess.on("error", rej);
          soxProcess.on("close", (soxCode: number) => {
            if (soxCode !== 0) {
              console.error(
                `Sox process exited with code ${soxCode}${soxErr.trim() ? `: ${soxErr.trim()}` : ""}`
              );
              rej(new Error(`Sox process exited with code ${soxCode}`));
            } else {
              // Replace original file with converted file
              fs.unlinkSync(tempWavFile);
              res();
            }
          });
        });

        const duration = (await getAudioDurationInSeconds(convertedWavFile)) * 1000;
        // Clean up temp file
        // fs.unlinkSync(convertedWavFile);
        console.log(`[TTS-DIAG][piper-http] ${convertedWavFile} duration ${Math.round(duration)}ms`);

        resolve({ filePath: convertedWavFile, duration });
      } catch (error) {
        // reject(error);
        console.log("Error processing Piper output:", `"${text}"`, error);
        removeFile(tempWavFile);
        resolve({ duration: 0 });
      }
    });

    piperProcess.on("error", (error: any) => {
      console.log("Piper process error:", `"${text}"`, error);
      resolve({ duration: 0 });
    });
  });
};

function cleanup() {
  if (pyProcess && !pyProcess.killed) {
    console.log("Killing python server...");
    process.kill(-pyProcess.pid!, "SIGTERM");
  }
}

process.on("SIGINT", cleanup); // Ctrl+C
process.on("SIGTERM", cleanup); // systemctl / docker stop
process.on("exit", cleanup);
process.on("uncaughtException", (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});


export default piperHttpTTS;
