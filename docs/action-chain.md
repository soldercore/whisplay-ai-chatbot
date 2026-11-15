# Multi-action TV requests

Status: candidate `candidate/action-chain`, **not deployed**. No configuration switch: a request that is not a valid chain is routed exactly as before.

"Turn on the TV, search YouTube for Interstellar soundtrack, and set the volume to 10." runs three existing, verified TV handlers in dependency order and gives **one** spoken reply.

## How it works (`src/config/action-chain.ts`, hooked in `ollama-llm.ts`)

1. **Plan, pure and deterministic.** The request is split only at a comma, "and", "then" or "and then" that is followed by a request verb. Every clause must be recognised by the same whole-sentence matchers that route a single command (screen, volume, mute, YouTube search/open, power). Nothing the model wrote is executed and there is no new grammar for actions.
2. **Validate the whole chain before anything runs.** An unsupported, ambiguous or unsafe clause refuses the entire request: nothing is executed, the reply names the clause and says nothing was changed. Refusals: unsupported clause, volume outside 0-100, TV and Whisplay named together (the existing "one device per request" reply), turn on and off together, any request after switching the TV off, two requests of the same kind, more than four steps.
3. **Order.** Power-on first, power-off last, everything else in spoken order.
4. **Contextual volume (approved decision).** A bare "volume" or "mute" clause means the TV only when the request is about the TV (the TV is named, or a clause is a YouTube request). "Set the volume to 10" on its own still means Whisplay's speaker.
5. **YouTube queries.** A query keeps its own "and" ("Tom and Jerry"). A boundary ends the query only if what follows is a recognised request, or if it is introduced by a comma or "then" (then an unrecognised clause refuses the chain). Before this change "Search YouTube for X and set the TV volume to 10" searched for the whole tail.
6. **Run.** The existing handlers (`turnOnTvAndReply`, `searchYoutubeAndReply`, `changeTvAudioAndReply`, ...) run one after another through the existing `hostAction` tags, so progress shows in the UI as before. Nothing is spoken per step.
7. **Failures.** If power-on is not confirmed, the other steps are skipped. An independent step that fails does not stop the others. A handler that throws is a failure, and an unrecognised reply is never treated as success.
8. **One reply.** Composed from the handlers' own replies. A search is described as "the search request went to YouTube": the integration verifies that the request was sent, not that results appeared. The short closing remark is added only with the GLaDOS persona and only when everything was verified.

Not chainable (a clause of this kind refuses the chain): TV navigation buttons, playback, notifications, and every Whisplay action (power, Wi-Fi, services and others that need confirmation), so no confirmation requirement can be bypassed.

## Rollback

Restore `dist/config/action-chain.js` (new file: delete) and `dist/cloud-api/local/ollama-llm.js` with their `src/` twins from the deploy backup; no configuration or data is involved. TV ducking, question follow-ups and Capri are untouched.
