import moment from "moment";
import { redactWifiCredentials } from "../../config/whisplay-privacy";
import { compact, noop } from "lodash";
import {
  onButtonPressed,
  onButtonReleased,
  onButtonDoubleClick,
  display,
  getCurrentStatus,
  onCameraCapture,
  onTextInput,
  isButtonDown,
} from "../../device/display";
import {
  recordAudio,
  recordAudioManually,
  recordFileFormat,
  getDynamicVoiceDetectLevel,
  recorderOnsetFix,
  voiceDetectEndSilenceSec,
} from "../../device/audio";
import { chatWithLLMStream, llmServer } from "../../cloud-api/server";
import { isImMode, summaryTextWithLLM } from "../../cloud-api/llm";
import { getSystemPromptWithKnowledge } from "../Knowledge";
import { enableRAG } from "../../cloud-api/knowledge";
import { cameraDir } from "../../utils/dir";
import {
  clearPendingCapturedImgForChat,
  getLatestGenImg,
  getLatestDisplayImg,
  setLatestCapturedImg,
  setPendingCapturedImgForChat,
} from "../../utils/image";
import { sendWhisplayIMMessage } from "../../cloud-api/whisplay-im/whisplay-im";
import { ChatFlowContext, FlowName, FlowStateHandler } from "./types";
import {
  enterCameraMode,
  handleCameraModePress,
  handleCameraModeRelease,
  onCameraModeExit,
  resetCameraModeControl,
} from "./camera-mode";
import { DEFAULT_EMOJI } from "../../utils";
import { isMusicPlaying, getCurrentTrackTitle, stopMusicPlayback, startPendingMusicPlayback, onMusicTrackChange, onMusicPlaybackEnd } from "../../device/music-player";
import { autoSaveExchange, prepareMemoryMessage } from "../../config/local-memory";
import type { Message } from "../../type";
import { unsupportedReminderReply } from "../../config/unsupported-reminder";
import { selfKnowledgeTopic } from "../../config/self-knowledge";
import { toolDisplayOutcome } from "../../config/action-outcome";
import { CLARIFICATION_SETTLE_MS, clarificationListenSeconds, QUESTION_LISTEN_SECONDS, conversationFollowUpLimit, endsWithQuestionMark, isNoiseTranscript, questionFollowUpLimit, shouldContinueConversation, shouldListenAfterAnswer } from "../../utils/pending-clarification";
import { uiStatus } from "../../utils/ui-status";
import { beginTurn, clearTurn, diagnosticsLine, finishTurn, hasTurn, mark as markTiming, toolFinished, toolStarted } from "../../utils/response-timing";
import fs from "node:fs";
import { whisplayHandoffTicket, presentWhisplayHandoff, cancelWhisplayHandoff } from "../../device/whisplay-control";
import { operationDeadline, waitForOperation } from "../../utils/operation-lifecycle";

export const flowStates: Record<FlowName, FlowStateHandler> = {
  sleep: (ctx: ChatFlowContext) => {
    ctx.conversationCapture = false;   // idle ends any follow-up capture marker
    onButtonPressed(async () => {
      resetCameraModeControl();
      // Stop any playing music when waking up
      stopMusicPlayback();
      await ctx.pauseWakeWordListener();
      if (ctx.currentFlowName !== "sleep") return;
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    onCameraModeExit(null);
    onTextInput(async (text: string) => {
      if (ctx.currentFlowName !== "sleep") return;
      await ctx.pauseWakeWordListener();
      if (ctx.currentFlowName !== "sleep") return;
      ctx.answerId += 1;
      ctx.conversationFollowUps = Math.max(conversationFollowUpLimit(), questionFollowUpLimit());   // a typed turn never opens the microphone by itself
      ctx.conversationCapture = false;
      clearTurn();
      text = redactWifiCredentials(text);
      ctx.asrText = text;
      display({ status: "recognizing", text, text_input_enabled: false });
      ctx.transitionTo("answer");
    });
    if (ctx.enableCamera) {
      const captureImgPath = `${cameraDir}/capture-${moment().format(
        "YYYYMMDD-HHmmss",
      )}.jpg`;
      onButtonDoubleClick(async () => {
        await ctx.pauseWakeWordListener();
        if (ctx.currentFlowName !== "sleep") return;
        enterCameraMode(captureImgPath);
        ctx.transitionTo("camera");
      });
    }
    // A host question is waiting for the user's next request. Show that, without suggesting the microphone is open:
    // the status clears when the window ends, and answering still takes the button or the wake word.
    ctx.scheduleIdleRefresh();
    display({
      status: ctx.idleStatus(),
      emoji: "😴",
      RGB: "#000055",
      rag_icon_visible: false,
      ...(getCurrentStatus().text.endsWith("Listening...") || !getCurrentStatus().text
        ? {
          text: `Long Press the button to say something${ctx.enableCamera ? ",\ndouble click to launch camera" : ""
            }.`,
        }
        : {}),
    });
  },
  camera: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(() => {
      handleCameraModePress();
    });
    onButtonReleased(() => {
      handleCameraModeRelease();
    });
    onCameraCapture(() => {
      const captureImagePath = getCurrentStatus().capture_image_path;
      if (!captureImagePath) {
        return;
      }
      setLatestCapturedImg(captureImagePath);
      setPendingCapturedImgForChat(captureImagePath);
      display({ image_icon_visible: true });
    });
    onCameraModeExit(() => {
      if (ctx.currentFlowName === "camera") {
        ctx.transitionTo("sleep");
      }
    });
    display({
      status: "camera",
      emoji: "📷",
      RGB: "#00ff88",
    });
  },
  music: (ctx: ChatFlowContext) => {
    // Start deferred music playback when entering music state
    startPendingMusicPlayback();

    // Update display when track changes during continuous playback
    onMusicTrackChange((title) => {
      if (ctx.currentFlowName === "music") {
        display({ text: `Now playing: ${title}` });
      }
    });

    // Return to sleep when non-continuous playback finishes
    onMusicPlaybackEnd(() => {
      if (ctx.currentFlowName === "music") {
        onMusicTrackChange(null);
        onMusicPlaybackEnd(null);
        ctx.transitionTo("sleep");
      }
    });

    onButtonDoubleClick(null);
    onButtonPressed(() => {
      // Stop music immediately when button is pressed
      onMusicTrackChange(null);
      onMusicPlaybackEnd(null);
      stopMusicPlayback();
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);

    const trackTitle = getCurrentTrackTitle();
    display({
      status: "music",
      emoji: "🎹",
      RGB: "#0066aa",
      text:
        ctx.musicDisplayText ||
        (isMusicPlaying() && trackTitle
          ? `Now playing: ${trackTitle}`
          : "Music mode. Press the button to talk."),
      rag_icon_visible: false,
    });
  },
  listening: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.isFromWakeListening = false;
    ctx.answerId += 1;
    ctx.wakeSessionActive = false;
    ctx.endAfterAnswer = false;
    ctx.conversationFollowUps = 0;   // a button-started turn begins a new conversation
    ctx.conversationCapture = false;
    onButtonDoubleClick(null);
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(noop);
    const listeningStartedAt = Date.now();
    // If button was already released before we entered this state, go back to sleep
    if (!isButtonDown()) {
      console.log("[listening] Button already released, returning to sleep");
      ctx.transitionTo("sleep");
      return;
    }
    const { result, stop } = recordAudioManually(ctx.currentRecordFilePath);
    let shouldIgnoreRecordingResult = false;
    const handleRelease = () => {
      if (Date.now() - listeningStartedAt < 500) {
        // Too short to be meaningful — stop recording and return to sleep
        console.log("[listening] Button released too quickly, returning to sleep");
        shouldIgnoreRecordingResult = true;
        stop();
        ctx.transitionTo("sleep");
        return;
      }
      beginTurn("button", performance.now());   // end of speech = button release
      stop();
      display({
        RGB: "#ff6800",
        image: "",
      });
    };
    onButtonReleased(handleRelease);
    result
      .then(() => {
        if (shouldIgnoreRecordingResult) return;
        ctx.transitionTo("asr");
      })
      .catch((err) => {
        console.error("Error during recording:", err);
        ctx.transitionTo("sleep");
      });
    display({
      status: "listening",
      emoji: DEFAULT_EMOJI,
      RGB: "#00ff00",
      text: "Listening...",
      rag_icon_visible: false,
    });
  },
  wake_listening: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.isFromWakeListening = true;
    const clarification = ctx.clarificationListen;   // one-shot: a bounded capture for a clarification answer
    ctx.clarificationListen = false;
    const followUpSeconds = ctx.followUpSeconds;   // one-shot: the shorter window of a question-triggered follow-up
    ctx.followUpSeconds = undefined;
    ctx.answerId += 1;
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(() => {
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    // The ambient-level calibration only feeds the old start-level trigger. With RECORDER_ONSET_FIX the recorder ignores
    // that level (vad trigger), so the calibration and its screen are skipped and the capture starts at once.
    const startCapture = (level: number): void => {
      const maxSec = clarification ? (followUpSeconds ?? clarificationListenSeconds()) : ctx.wakeRecordMaxSec;
      const mode = clarification ? `answer:${maxSec}` : "auto";
      display({
        status: uiStatus("listening", mode),
        emoji: DEFAULT_EMOJI,
        RGB: "#00ff00",
        text: recorderOnsetFix ? "Listening..." : `(Detect level: ${level}%) Listening...`,
        rag_icon_visible: false,
      });
      // The recorder writes nothing until sound passes its start level, so growth of its file is real speech detection.
      const recordingFile = ctx.currentRecordFilePath;
      const startedAt = performance.now();
      let spoke = false;
      let poll: ReturnType<typeof setInterval> | undefined = setInterval(() => {
        try {
          if (fs.statSync(recordingFile).size > 1024) {
            display({ status: uiStatus("listening", mode, "audio") });   // the recorder wrote sound: energy over its start level
            spoke = true;
            if (poll) { clearInterval(poll); poll = undefined; }
          }
        } catch { /* the file does not exist yet */ }
      }, 250);
      const stopPolling = () => { if (poll) { clearInterval(poll); poll = undefined; } };
      // A follow-up or clarification listen has a short WAITING window (maxSec); once the person has started speaking the recording is
      // allowed to finish (up to the normal wake recording limit) instead of being cut at the end of that window.
      const speechLimit = clarification ? ctx.wakeRecordMaxSec : undefined;
      recordAudio(recordingFile, maxSec, level, speechLimit)
        .then(() => {
          stopPolling();
          // The recorder stops only after its end-silence, so the speech ended that long before it stopped (unless the time limit ended it).
          const ended = performance.now();
          const hardEnd = (maxSec + (spoke && speechLimit ? speechLimit : 0)) * 1000;
          const bySilence = ended - startedAt < hardEnd - 250;
          beginTurn("auto", bySilence ? ended - voiceDetectEndSilenceSec * 1000 : ended);
          ctx.transitionTo("asr");
        })
        .catch((err) => {
          stopPolling();
          console.error("Error during auto recording:", err);
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        });
    };
    if (recorderOnsetFix) {
      startCapture(0);
    } else {
      display({
        status: "detecting",
        emoji: DEFAULT_EMOJI,
        RGB: "#00ff00",
        text: "Detecting voice level...",
        rag_icon_visible: false,
      });
      getDynamicVoiceDetectLevel().then(startCapture);
    }
  },
  asr: (ctx: ChatFlowContext) => {
    display({
      status: "recognizing",
      RGB: "#ff6800",   // recording is over, whatever started it: the LED must not stay on the recording colour
    });
    onButtonDoubleClick(null);
    const conversational = ctx.conversationCapture;   // set only for an automatic conversational follow-up capture
    ctx.conversationCapture = false;
    Promise.race([
      ctx.recognizeAudio(ctx.currentRecordFilePath, ctx.isFromWakeListening).catch((error: unknown) => {
        console.error("[asr] Recognition failed, treated as silence:", error instanceof Error ? error.message : error);
        return "";
      }),
      new Promise<string>((resolve) => {
        onButtonPressed(() => {
          resolve("[UserPress]");
        });
        onButtonReleased(noop);
      }),
    ]).then((result) => {
      if (ctx.currentFlowName !== "asr") return;
      if (result === "[UserPress]") {
        ctx.transitionTo("listening");
        return;
      }
      if (result && conversational && isNoiseTranscript(result)) {
        console.log("[asr] Follow-up heard only noise or a stock phrase; back to idle.");   // no text is kept or acted on
        result = "";
      }
      if (result) {
        result = redactWifiCredentials(result);
        console.log("Audio recognized result:", result);
        ctx.asrText = result;
        markTiming("transcribed");
        ctx.endAfterAnswer = ctx.shouldEndAfterAnswer(result);
        if (ctx.wakeSessionActive) {
          ctx.wakeSessionLastSpeechAt = Date.now();
        }
        display({ status: "recognizing", text: result });
        ctx.transitionTo("answer");
        return;
      }
      if (ctx.wakeSessionActive) {
        if (ctx.shouldContinueWakeSession()) {
          ctx.transitionTo("wake_listening");
        } else {
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        }
        return;
      }
      ctx.transitionTo("sleep");
    });
  },
  answer: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.resetToolCallDisplay();
    ctx.answerDisplayText = "";
    display({
      status: uiStatus("answering...", hasTurn() && "said"),   // "said": the text on screen is what speech recognition returned
      RGB: "#00c8a3",
    });
    const currentAnswerId = ctx.answerId;
    const unsupportedReminder = llmServer === "ollama" && (unsupportedReminderReply(ctx.asrText) !== null || selfKnowledgeTopic(ctx.asrText) !== undefined);
    if (isImMode) {
      const prompt: {
        role: "system" | "user";
        content: string;
      }[] = [
          {
            role: "user",
            content: ctx.asrText,
          },
        ];
      sendWhisplayIMMessage(prompt)
        .then((ok) => {
          if (ok) {
            display({
              status: "idle",
              emoji: "😊",
              RGB: "#000055",
              image_icon_visible: false,
            });
          } else {
            display({
              status: "error",
              emoji: "⚠️",
              text: "OpenClaw send failed",
              image_icon_visible: false,
            });
          }
        })
        .finally(() => {
          clearPendingCapturedImgForChat();
          ctx.transitionTo("sleep");
        });
      return;
    }
    onButtonPressed(() => {
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    const {
      partial,
      endPartial,
      getPlayEndPromise,
      stop: stopPlaying,
    } = ctx.streamResponser;
    let llmResponseText = "";
    const isCurrentAnswer = (): boolean =>
      currentAnswerId === ctx.answerId && ctx.currentFlowName === "answer";
    const trackingPartial = (text: string): void => {
      if (!isCurrentAnswer()) return;
      markTiming("firstText");
      llmResponseText += text;
      // The screen shows the answer as it is spoken (see SpokenTextReveal).
      partial(text);
    };
    let deviceHandoff: string | undefined;
    let toolRan = false;     // any tool or host-routed device action in this turn: no automatic follow-up after it
    let llmFailed = false;
    let resolveLlmDone: () => void = () => {};
    const llmDonePromise = new Promise<void>((resolve) => {
      resolveLlmDone = resolve;
    });
    ctx.partialThinking = "";
    ctx.thinkingSentences = [];
    Promise.all([
      [() => Promise.resolve().then(() => ""), getSystemPromptWithKnowledge]
      [enableRAG && !unsupportedReminder ? 1 : 0](ctx.asrText),
      Promise.resolve().then(() => prepareMemoryMessage(ctx.asrText)),
    ])
      .then(([res, memoryMessage]) => {
        const knowledgePrompt = res;
        if (res) {
          console.log("Retrieved knowledge for RAG:\n", res);
        }
        display({
          rag_icon_visible: Boolean(enableRAG && knowledgePrompt),
        });
        const prompt: Message[] = compact([
          memoryMessage,
          knowledgePrompt
            ? {
              role: "system",
              content: knowledgePrompt,
              contextScope: "turn" as const,
            }
            : null,
          {
            role: "user",
            content: ctx.asrText,
          },
        ]);
        chatWithLLMStream(
          prompt,
          trackingPartial,
          () => {
            if (isCurrentAnswer()) {
              endPartial();
            }
            resolveLlmDone();
          },
          (partialThinking) =>
            isCurrentAnswer() &&
            ctx.partialThinkingCallback(partialThinking),
          (functionName: string, result?: string) => {
            if (!isCurrentAnswer()) return;
            toolRan = true;
            if (functionName === "whisplay") {
              const ticket = whisplayHandoffTicket(result);
              if (ticket) deviceHandoff = ticket;
            }
            if (
              functionName === "endConversation" &&
              result?.startsWith("[success]")
            ) {
              ctx.endAfterAnswer = true;
            }
            if (
              functionName === "generateImage" &&
              result?.startsWith("[success]")
            ) {
              const img = getLatestGenImg();
              if (img) {
                display({ image: img });
              }
            }
            if (
              functionName.startsWith("playMusic") &&
              result?.startsWith("[success]")
            ) {
              ctx.enterMusicAfterAnswer = true;
              ctx.musicDisplayText = result.replace(/^\[success\]/, "").trim();
            }
            if (!result) {
              toolStarted();
            } else {
              toolFinished(result.startsWith("[host:"));   // a host-routed device action: its outcome time is the action metric
            }
            if (!result) {
              ctx.appendToolCallDisplay(functionName);
            } else if (
              functionName === "runCommand" &&
              result.startsWith("[success] status=running")
            ) {
              const jobId = result.match(/\bjob_id=([^\s]+)/)?.[1];
              if (jobId) {
                ctx.keepCommandToolDisplayRunning(jobId);
              } else {
                ctx.finishToolCallDisplay(functionName);
              }
            } else if (
              result.includes("status=completed")
            ) {
              const jobId = result.match(/\bjob_id=([^\s]+)/)?.[1];
              if (jobId) {
                ctx.finishCommandToolDisplay(jobId);
              }
              ctx.finishToolCallDisplay(functionName);
            } else {
              ctx.finishToolCallDisplay(functionName, toolDisplayOutcome(result));
            }
          },
        ).catch((error) => {
          console.error("[answer] LLM stream failed:", error);
          llmFailed = true;
          if (isCurrentAnswer()) {
            endPartial();
          }
          resolveLlmDone();
        });
      })
      .catch((error) => {
        console.error("[answer] Failed to prepare prompt:", error);
        if (currentAnswerId === ctx.answerId) {
          resolveLlmDone();
          ctx.transitionTo("sleep");
        }
      });
    llmDonePromise.then(() => getPlayEndPromise()).then(async () => {
      if (deviceHandoff && !isCurrentAnswer()) cancelWhisplayHandoff(deviceHandoff);
      if (isCurrentAnswer()) {
        const timing = finishTurn();   // playback has ended: publish the one shown value and log the details
        if (timing) console.info(diagnosticsLine(timing));
        ctx.revealAllAnswerText();
      }
      if (ctx.currentFlowName === "answer") {
        const savedExchange = autoSaveExchange(ctx.asrText, llmResponseText, unsupportedReminder || deviceHandoff ? undefined : summaryTextWithLLM);
        clearPendingCapturedImgForChat();
        display({ image_icon_visible: false });
        if (deviceHandoff && isCurrentAnswer()) {
          const deadline = operationDeadline(5000);
          try {
            await waitForOperation(Promise.resolve(savedExchange), deadline.signal);
          } catch {
            cancelWhisplayHandoff(deviceHandoff);
            display({ text: "Device handoff cancelled: conversation saving was not confirmed." });
            ctx.transitionTo("sleep");
            return;
          } finally { deadline.dispose(); }
          if (!isCurrentAnswer()) { cancelWhisplayHandoff(deviceHandoff); return; }
          // Speech has finished. Daemon cleanup owns the actual focus/mic handoff.
          void presentWhisplayHandoff(deviceHandoff).catch(error => {
            console.error("[Whisplay] Handoff failed:", error.message);
            display({ text: "Device handoff failed. Use the physical Home gesture." });
          });
          ctx.transitionTo("sleep");
          return;
        }
        // A host question is waiting for one short answer: the playback has fully ended, so after a short settle reopen the
        // existing auto-recording state once. Silence ends it back in sleep; it is never taken as an answer.
        // The same reopen serves an ordinary conversational answer (a short, bounded chain; see shouldContinueConversation).
        const clarificationListen = isCurrentAnswer() && shouldListenAfterAnswer(ctx);
        const asksQuestion = endsWithQuestionMark(llmResponseText);
        const conversationListen = !clarificationListen && isCurrentAnswer() && shouldContinueConversation({
          used: ctx.conversationFollowUps,
          // every ordinary answer may follow up to the general limit; a reply that ends with "?" up to the question limit
          limit: asksQuestion ? Math.max(conversationFollowUpLimit(), questionFollowUpLimit()) : conversationFollowUpLimit(),
          wakeSessionActive: ctx.wakeSessionActive,
          endAfterAnswer: ctx.endAfterAnswer, toolRan, failed: llmFailed, answered: llmResponseText.trim().length > 0,
          musicNext: ctx.enterMusicAfterAnswer,
        });
        if (clarificationListen || conversationListen) {
          setTimeout(() => {
            if (ctx.currentFlowName !== "answer" || !isCurrentAnswer()) return;   // interrupted, replaced or ended meanwhile
            if (conversationListen) {
              ctx.conversationFollowUps += 1;
              ctx.conversationCapture = true;
              if (asksQuestion) ctx.followUpSeconds = QUESTION_LISTEN_SECONDS;
            }
            ctx.clarificationListen = true;
            ctx.transitionTo("wake_listening");
          }, CLARIFICATION_SETTLE_MS);
          return;
        }
        if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
          if (ctx.endAfterAnswer) {
            ctx.endWakeSession();
            ctx.transitionTo("sleep");
          } else {
            ctx.transitionTo("wake_listening");
          }
          return;
        }
        if (ctx.enterMusicAfterAnswer) {
          ctx.transitionTo("music");
          return;
        }
        const img = getLatestDisplayImg();
        if (img) {
          ctx.transitionTo("image");
        } else {
          ctx.transitionTo("sleep");
        }
      }
    });
    onButtonPressed(() => {
      stopPlaying();
      clearPendingCapturedImgForChat();
      display({ image_icon_visible: false });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
  },
  image: (ctx: ChatFlowContext) => {
    onButtonPressed(() => {
      display({ image: "" });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
  },
  approval: (ctx: ChatFlowContext) => {
    const request = ctx.pendingApprovalRequest;
    if (!request) {
      ctx.transitionTo("sleep");
      return;
    }

    onButtonDoubleClick(null);
    let pressStartedAt = 0;
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;
    const parsedLongPressMs = parseInt(
      process.env.WHISPLAY_IM_APPROVAL_LONG_PRESS_MS || "900",
      10,
    );
    const longPressMs = Number.isFinite(parsedLongPressMs)
      ? Math.max(500, parsedLongPressMs)
      : 900;

    const finish = (approved: boolean): void => {
      if (finished) return;
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      request.respond(approved);
      ctx.pendingApprovalRequest = null;
      display({
        status: approved ? "Allowed" : "Denied",
        emoji: approved ? "✅" : "⛔",
        text: approved ? "Operation allowed." : "Operation denied.",
        RGB: approved ? "#00c8a3" : "#ff3030",
        approval_mode: false,
        scroll_speed: 0,
      });
      setTimeout(() => {
        if (ctx.currentFlowName === "approval") {
          ctx.transitionTo("sleep");
        }
      }, 600);
    };

    timeout = setTimeout(() => finish(false), request.timeoutMs);
    onButtonPressed(() => {
      pressStartedAt = Date.now();
    });
    onButtonReleased(() => {
      const pressDuration = Date.now() - pressStartedAt;
      finish(pressDuration < longPressMs);
    });

    const lines = compact([
      request.tool ? `[${request.tool}] ${request.title}` : request.title,
      request.text,
    ]);
    display({
      status: "Confirm",
      emoji: "🔐",
      text: lines.join("\n\n"),
      RGB: "#ffb000",
      approval_mode: true,
      text_input_enabled: false,
      scroll_speed: 2,
      image: "",
    });
  },
  external_answer: (ctx: ChatFlowContext) => {
    if (!ctx.pendingExternalReply && !ctx.pendingExternalImageUrl) {
      ctx.transitionTo("sleep");
      return;
    }
    ctx.resetToolCallDisplay();
    ctx.answerDisplayText = "";
    display({
      status: "answering...",
      RGB: "#00c8a3",
      ...(ctx.pendingExternalEmoji ? { emoji: ctx.pendingExternalEmoji } : {}),
    });
    onButtonPressed(() => {
      ctx.streamResponser.stop();
      display({ image: "" });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    const replyText = ctx.pendingExternalReply;
    const replyEmoji = ctx.pendingExternalEmoji;
    const replyImageUrl = ctx.pendingExternalImageUrl;
    ctx.currentExternalEmoji = replyEmoji;
    ctx.pendingExternalReply = "";
    ctx.pendingExternalEmoji = "";
    ctx.pendingExternalImageUrl = "";

    // Display the image if one was provided
    if (replyImageUrl) {
      display({ image: replyImageUrl });
    }

    if (replyText) {
      void ctx.streamExternalReply(replyText, replyEmoji);
      ctx.streamResponser.getPlayEndPromise().then(() => {
        if (ctx.currentFlowName !== "external_answer") return;
        ctx.revealAllAnswerText();
        if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
          if (ctx.endAfterAnswer) {
            ctx.endWakeSession();
            ctx.transitionTo("sleep");
          } else {
            ctx.transitionTo("wake_listening");
          }
        } else if (replyImageUrl) {
          // Stay in image display mode after TTS finishes
          ctx.transitionTo("image");
        } else {
          ctx.transitionTo("sleep");
        }
      });
    } else {
      // Image only, no text to speak — go to image display mode
      ctx.transitionTo("image");
    }
  },
};
