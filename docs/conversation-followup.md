# Conversational follow-ups

After an ordinary spoken answer the existing clarification follow-up listen reopens, so a conversation can continue without
saying "Capri" again.

Reused unchanged: playback must have fully ended (`getPlayEndPromise`), then the 300 ms settle (`CLARIFICATION_SETTLE_MS`),
then `wake_listening` with the 7 s bounded capture (`CLARIFICATION_LISTEN_SEC`). The heard text goes through the normal `asr` and
`answer` states, so history, memory, tools and persona are as for any turn. Capri is stopped for the whole conversation (leaving
`sleep`) and restarts when the conversation returns to idle, so there is no microphone contention.

Rule (`shouldContinueConversation`): a follow-up listen opens only when the answer was produced, completed, was not interrupted,
ran no tool or host-routed device action, did not end the conversation (goodbye/stop/endConversation), is not followed by music, no
clarification window is open, and fewer than `CONVERSATION_FOLLOWUPS` follow-ups (default 3, max 5, `0` = off) were used. The
counter resets when a Capri command or a button turn starts; a typed turn never listens.

Silence, an empty or failed recognition, or a transcript that is only noise or a stock phrase ("Thank you.", "you", "bye"...)
returns to idle (`isNoiseTranscript`, conversational follow-ups only; clarification answers are unchanged).

Tests: `src/test/conversation-followup.spec.ts` (with mutation checks documented in the commit).
