import fs from "node:fs";

// Guard before side-effectful imports: direct `node dist/index.js` on Linux
// must not bypass the launcher's lock and start competing hardware processes.
export function requireLauncherLock(): void {
  if (process.platform !== "linux") return;
  const expected = `/tmp/whisplay-chatbot-${process.getuid!()}/application.lock`;
  try {
    if (process.env.WHISPLAY_APPLICATION_LOCK !== expected) throw new Error("missing launcher lock");
    const file = fs.lstatSync(expected), fd = fs.fstatSync(9);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid!()
      || file.dev !== fd.dev || file.ino !== fd.ino) throw new Error("invalid launcher lock");
  } catch {
    throw new Error("Start GLaDOS with whisplay service start, npm start, or bash run_chatbot.sh (Linux instance lock required)");
  }
}
