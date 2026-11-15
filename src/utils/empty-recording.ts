import { existsSync, statSync } from "fs";

const WAV_HEADER_BYTES = 44;

/**
 * True when the recording file contains audio data. A recorder that heard nothing (the user simply did not answer) leaves no file,
 * an empty file or a WAV header with no samples; none of these may be sent to speech recognition.
 */
export const recordingHasAudio = (filePath: string): boolean => {
  try {
    if (!existsSync(filePath)) return false;
    const { size } = statSync(filePath);
    return filePath.toLowerCase().endsWith(".wav") ? size > WAV_HEADER_BYTES : size > 0;
  } catch {
    return false;
  }
};
