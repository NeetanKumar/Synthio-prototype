# PLAN — "Lumirexa" AI Medical Science Liaison

> Status: implemented. See README.md and docs/ for the current design.

A voice agent presents a fictional topical drug to a physician. It routes questions to the right slide, can be interrupted mid-sentence, and flags compliance events.

---

## 0. Verification notes

- **Docs access:** `platform.openai.com` and `developers.openai.com` are blocked by this sandbox's network policy. I verified against two official OpenAI npm packages instead:
  - `openai@7.51.0`: types generated from OpenAI's OpenAPI spec.
  - `@openai/agents-realtime@0.21.0`: OpenAI's own browser WebRTC transport.
- **No live testing from here:** `api.openai.com` is also unreachable from this sandbox, so live voice tests must run on your machine. Everything that doesn't need the network (unit tests, build, UI with a mocked data channel) I can verify here.
- **Fictional names:** web searches for the brand "Lumirexa" and the generic "tavrocitinib" return no drug.
  - The `-citinib` ending is the real USAN stem for JAK inhibitors, so a pharma reviewer will find the name plausible.
  - The closest real names are lumiracoxib (withdrawn) and abrocitinib (oral JAK1). Neither collides.

### Verified API surface

| What | Exact detail |
|---|---|
| Model | `gpt-realtime-2.1`, the default in OpenAI's own SDK. It is a reasoning model, so I use `reasoning.effort: "minimal"` to keep latency low. Fallbacks: `gpt-realtime-2.1-mini` and `gpt-realtime`. |
| Voices | `marin`, `cedar` (newest), plus `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse` |
| Mint secret | `POST https://api.openai.com/v1/realtime/client_secrets`<br>Body: `{ expires_after:{anchor:"created_at",seconds:60}, session:{type:"realtime", model, instructions, audio:{input:{transcription, noise_reduction, turn_detection}, output:{voice}}, tools, tool_choice, reasoning} }`<br>Response: `{ value, expires_at, session }` |
| SDP exchange (browser) | `POST https://api.openai.com/v1/realtime/calls`<br>Headers: `Authorization: Bearer <ephemeral value>`, `Content-Type: application/sdp`<br>Body: the SDP offer. Response: the SDP answer, with the call id in the `Location` header. |
| Data channel | `pc.createDataChannel("oai-events")` |
| Turn detection | Set at `session.audio.input.turn_detection`. Two types:<br>• `server_vad`: `threshold`, `prefix_padding_ms`, `silence_duration_ms`, `create_response`, `interrupt_response`, `idle_timeout_ms`<br>• `semantic_vad`: `eagerness`, `create_response`, `interrupt_response` |
| Transcription | `audio.input.transcription: { model: "gpt-4o-mini-transcribe" }` |
| Client events | `session.update`, `conversation.item.create`, `response.create` (accepts `instructions`, `metadata`, `tool_choice`, `input`), `response.cancel {response_id?}`, `output_audio_buffer.clear` (WebRTC only; send after `response.cancel`, the same order the SDK uses), `conversation.item.truncate {item_id, content_index, audio_end_ms}` |
| Server events | `session.created/updated`, `input_audio_buffer.speech_started/speech_stopped`, `response.created/done`, `response.output_audio_transcript.delta/done`, `response.function_call_arguments.done {call_id,name,arguments}`, `output_audio_buffer.started/stopped/cleared` (WebRTC only), `conversation.item.input_audio_transcription.delta/completed`, `conversation.item.truncated`, `error` |
| Tool result | `conversation.item.create { item:{ type:"function_call_output", call_id, output: JSON string } }`, then `response.create` to continue |
| Server hangup | `POST /v1/realtime/calls/{call_id}/hangup`, used to enforce the session limit server-side |
| Text-only input | `conversation.item.create { item:{type:"message", role:"user", content:[{type:"input_text", text}]} }`, then `response.create` |

---

## 1. File tree

```
/package.json                 npm workspaces; `npm run dev` = concurrently(server, web)
/shared/src
  deck.ts                     zod: Deck, Slide, Element (bullet|chart|table|diagram), stable IDs
  tools.ts                    zod schemas for tool args + JSON-schema export for the session
  events.ts                   telemetry event union (zod)
/server/src
  index.ts                    Fastify bootstrap, CORS, rate-limit
  routes/realtime.ts          POST /api/realtime/session  → mint secret, register call, start hangup timer
  routes/decks.ts             GET  /api/decks/:id
  routes/sessions.ts          POST /api/sessions/:id/events, POST /api/sessions/:id/summary
  prompt.ts                   buildInstructions(deck) — pure, unit-tested
  sessionConfig.ts            model, voice, VAD, tools → session object
  db.ts                       node:sqlite (built into Node 22, no native build step)
  decks/lumirexa.json, decks/onboarding.json   (second, generic deck for ?deck=)
  eval/questions.json, eval/run.ts
/web/src
  realtime/connection.ts      RTCPeerConnection, mic, data channel, reconnect
  realtime/eventBus.ts        typed event parsing (zod on the hot paths only)
  agent/machine.ts            pure reducer: agent state + mode (unit-tested)
  agent/toolHandler.ts        validate → apply → output (unit-tested)
  agent/cursor.ts             narration cursor
  agent/presenter.ts          auto-advance loop
  ui/ SlideStage, ThumbRail, Captions, Orb, MicMeter, DevHud, CallNotes, Toasts, TextFallback
  slides/ BulletList, EfficacyChart (Recharts), AeTable, MoaDiagram (inline SVG)
```

---

## 2. Key design decisions

1. **The client drives autonomous advancing; the model drives question routing.**
   - When a "present" response finishes playing (`output_audio_buffer.stopped`), the client moves to slide N+1 itself.
   - It then sends `response.create` with `metadata:{kind:"present", slide}` and short per-response `instructions` ("Present slide 3. Do not repeat earlier content.").
   - Why: pacing is deterministic and auditable, which matters in a regulated domain, and each slide saves one model round-trip.
   - `goto_slide` is reserved for the model routing a question.
2. **Gate visuals on audio.** If `goto_slide` arrives while earlier audio is still playing, the slide animation is queued until the buffer is idle. Otherwise the slide would change before the agent finished talking about the previous one.
3. **One added tool: `resume_presentation()`.** Without it, the client has to guess what "yes, carry on" means. Total tools: 4. Tell me if you want to stay strictly at 3.
4. **Interruption runs on two paths at once:**
   - **Local (instant):** on `speech_started`, mute the remote `<audio>` element. That is zero network round-trip, so silence comes in about 1 frame.
   - **Server:** `interrupt_response: true`. On WebRTC, the server cancels the response and truncates what was not heard, then sends `output_audio_buffer.cleared`, after which the client unmutes.
   - **Manual (Space / Stop):** mute, then `response.cancel`, then `output_audio_buffer.clear`.
   - The HUD reports both "interrupt → local silence" and "interrupt → server cleared".
5. **VAD: `server_vad`** (threshold 0.6, silence 450 ms, prefix 300 ms).
   - Its `speech_started` fires on onset, which keeps barge-in fast and TTFA predictable.
   - `semantic_vad` (eagerness `high`) is available behind `?vad=semantic` for an A/B in the HUD.
   - `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})`.
6. **Narration cursor.** Stored as `{slideId, sentences[], playedUntilIdx}`.
   - Transcript deltas arrive ahead of the audio, so the client estimates how much was actually heard: playback time since `output_audio_buffer.started` × a characters-per-ms rate, calibrated on earlier responses.
   - On resume, the client sends `response.create` with instructions like: "Resume slide 3 after: '<last heard sentence>'. Do not restart."
   - The server-side truncation (decision 4) also keeps the model's context aligned with what was heard.
7. **Bidirectional navigation.** When the user clicks next/prev or a thumbnail:
   1. Cancel and clear the current response.
   2. Inject a system message: "User navigated to slide X".
   3. Send `response.create` (kind `present`, slide X).
8. **Edge cases:**
   - **Tool call mid-response:** queue the tool output and send `response.create` only after `response.done`, so two responses never overlap. A `responseInFlight` guard enforces this.
   - **Duplicate goto:** if the target is already the current slide, return `{ok:true, noop:true}`.
   - **Invalid ID:** return `{ok:false, error, valid_ids}` so the model can self-correct.
   - **Connection drop:** on `connectionstatechange` = failed, mint a new secret, open a new peer connection, and re-seed the model with a compact recap (slide, cursor, Q&A so far).
   - **Mic denied:** use a recvonly audio transceiver plus the text input. The voice still plays, and the session is the same one.
9. **Cost guard:**
   - `@fastify/rate-limit`: 5 sessions per IP per hour on `/realtime/session`.
   - Ephemeral secret TTL is 60 s.
   - Session limit is 8 min. The server stores the call id (the client reports it from the `Location` header) and calls `/hangup` itself, so the limit holds even if the client misbehaves. A client countdown is shown in the UI.
10. **Eval: run the realtime model in text-only mode.** A server-side WebSocket uses the same model, instructions, and tools, with `output_modalities:["text"]`.
    - The spec says "text model". A separate chat model would be a proxy that routes differently, so running the same realtime model in text mode measures routing more honestly.
    - `gpt-5.4-mini` is the fallback, and also writes the call-notes summary.

---

## 3. State machine (`web/src/agent/machine.ts`, pure reducer)

The reducer tracks two values: `agent`, the orb state, and `mode`, the conversation phase.

```
agent: idle | listening | thinking | speaking | interrupted | reconnecting
mode:  presenting | answering | paused | ended

speech_started            → listening   (if was speaking: mark turn "interrupted", local mute)
speech_stopped            → thinking    (start TTFA timer)
text_submitted            → thinking
response.created          → thinking
output_audio_buffer.started→ speaking   (stop TTFA timer)
output_audio_buffer.cleared→ interrupted → (300ms) listening|idle
output_audio_buffer.stopped→ idle; if mode=presenting && kind=present → advance()
tool goto_slide           → mode=answering
tool resume_presentation  → mode=presenting, resume from cursor
user nav (click/thumb)    → cancel; mode=presenting at X
Space/Stop                → cancel; agent=interrupted; mode=paused
pc failed                 → reconnecting → (re-seed) → previous mode
last slide done           → mode=answering (open Q&A)
timer expired             → ended → call notes
```

---

## 4. Event flows

**Question → slide change**
1. The user speaks and `speech_started` fires; the orb switches to listening, and any audio is muted.
2. `speech_stopped`, then `response.created`.
3. `function_call_arguments.done(goto_slide)` arrives. The client validates the slide ID, animates, and sends `function_call_output`.
4. `response.done`, then the client sends `response.create`.
5. The model answers in 3 sentences or fewer, using `highlight()` as it goes, and offers to resume.

**Interrupt**
1. `speech_started` fires; the client mutes locally and marks the turn interrupted (t0).
2. The server cancels the response and sends `output_audio_buffer.cleared` (t1). The client unmutes.
3. The cursor saves the last heard sentence.
4. The user's question is handled as in the flow above.

---

## 5. Prompt (summary; full text in `server/src/prompt.ts`)

The prompt has these parts:

- **Role:** a medical science liaison speaking to a physician.
- **Content rules:**
  - Speak, don't read: 2–4 sentences per slide.
  - Answers come only from the deck plus the hidden `knowledge` field, in 3 sentences or fewer, then offer to resume.
  - Never invent numbers. If something isn't in the deck, say so.
- **Tool rules:**
  - Call `goto_slide` before talking about another slide's content.
  - Call `highlight` on each element as it is discussed.
  - Off-label or unknown topics: decline briefly and call `flag_for_followup`.
  - A patient side effect mentioned: acknowledge it, call `flag(adverse_event)`, and offer the safety reporting route.
- **Deck digest:** slide IDs, titles, element IDs, and knowledge, serialized compactly.

The prompt stays server-side; the browser never sees it.

---

## 6. Risks (ranked)

1. **Live voice can't be tested from this sandbox.** Mitigation: a mock data-channel harness covers state, tool, and cursor logic. You run the P0 smoke test locally with your key, and I can add a scripted `npm run smoke` if useful.
2. **Echo self-interrupt on laptop speakers.** Mitigation: AEC is on and the VAD threshold is 0.6; the demo uses headphones, and the README notes it.
3. **Reasoning-model latency.** Mitigation: `effort: minimal` and short `max_output_tokens`. If TTFA in the HUD is over about 1.2 s, fall back to `gpt-realtime-2.1-mini`.
4. **The model talks before calling `goto_slide`.** Mitigation: a strong prompt rule, measured by the eval. If routing is weak, I'll add a client fallback that runs `goto` when the transcript names a slide.
5. **Cursor estimate drift.** It is a heuristic, and the README will say so. The server-side truncation keeps the model's context correct regardless.
7. **Toolchain pinning.** The latest TypeScript is 7.0 (the native port). I'll pin TS 5.9 for ecosystem stability: Vite, Vitest and type plugins are battle-tested on it. Everything else is on current versions: Vite 8, React 19, Tailwind 4, `motion` 14 (Framer Motion's current package name), Recharts 3, Fastify 5, zod 4, Vitest 5.

---

## 7. Phases and commits

- **P0:** monorepo scaffold → deck schema + Lumirexa JSON → slide render → `/realtime/session` → WebRTC connect → autonomous presenting → `goto_slide` → interruption (local mute + server) → **demo**
- **P1:** highlight → flags + toasts → cursor resume → bidirectional nav → captions → orb + mic meter → text fallback → **demo**
- **P2:** Dev HUD → telemetry + call notes → eval → second deck → rate limit / hangup timer → README → **demo**

---

## 8. Need from you

1. An OpenAI API key with realtime access, for your local `.env`. I never need to see it.
2. OK on: **4 tools** (adding `resume_presentation`), **client-driven auto-advance**, and **eval via realtime text mode**.
