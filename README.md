# MSL·Live: an AI Medical Science Liaison you can interrupt

A voice agent briefs a physician on **Lumirexa™ (tavrocitinib) cream 1%**, a fictional topical JAK1 inhibitor for moderate-to-severe atopic dermatitis.

- It presents six slides on its own.
- When the physician asks a question, it jumps to the slide that holds the answer.
- It stops the moment the physician starts talking, and later resumes from the last sentence they actually heard.
- It flags adverse events and off-label questions as they happen.

> **Fictional product. Synthetic data. Demo only.** "Lumirexa" and "tavrocitinib" match no real drug. The `-citinib` ending follows the real naming convention for JAK inhibitors, so the name reads as plausible to clinicians.

- **Live:** `https://msl-live.vercel.app` _(placeholder until deployed)_
- **Loom:** _(placeholder)_

> **Guardrails:** content rules are measured by an eval (100% routing, 100% compliance-flag recall, 95% fact accuracy); secrets, tool calls, audit trail and cost limits are enforced in code. See [Guardrails](#guardrails).

## Run it (2 commands)

```bash
cp .env.example .env   # add OPENAI_API_KEY
npm install && npm run dev
```

Open http://localhost:5173 and click **Start briefing**. Use headphones so the agent doesn't hear itself through the speakers.

| Key | Action |
|---|---|
| speak | interrupt / ask a question |
| `Space` | stop the agent (manual barge-in) |
| `←` `→` / thumbnails | navigate; the agent follows |
| `D` | Dev HUD (latency, tool calls, resume cursor) |

- `?deck=voice-latency` loads a second, unrelated deck. Swapping the JSON swaps the topic.
- `?vad=semantic` switches turn detection to semantic VAD.

Other scripts:
- `npm test`: 63 unit tests.
- `npm run typecheck`: strict TS across all packages.
- `npm run eval`: routing eval against the live model.

---

## Guardrails

Built for a regulated setting: an AI talking to physicians about a drug. Some guardrails are **enforced in code** and cannot be talked around. Others are **instructed in the prompt** and **measured by the eval**, because a speech-to-speech model speaks as it generates and nothing can check the text first. Both kinds are listed below, with the evidence.

### Enforced in code (deterministic)

| Guardrail | How |
|---|---|
| Secrets and prompt never reach the browser | The server mints a 60-second ephemeral key with the instructions and tools baked in. `GET /api/decks/:id` strips speaker notes and hidden knowledge. |
| The agent can only do what the tools allow | Every tool argument is validated with zod. Unknown slide or element IDs are rejected and sent back to the model with the valid list. |
| Compliance audit trail | Every `flag_for_followup` (adverse event, off-label, out of scope) is shown to the user as a toast and logged to SQLite with timestamp and slide. |
| Call notes can't invent facts | Questions, flags, slides and latencies come from the event log. The text model only writes the prose and *selects* real questions from logged utterances; it can't add any. The summary mentions pharmacovigilance only if an adverse event was actually logged. |
| Synthetic-data disclosure | Every slide footer says "Fictional product. Synthetic data. Demo only."; the agent says so if asked. |
| Cost and abuse limits | Per-IP rate limit; per-session time budget enforced by a **server-side hang-up**; caps on events per session and on request size. |

### Instructed in the prompt, measured by the eval

v3 results: 21 questions × 3 runs; see [Results](#results).

| Guardrail | Agent behaviour | Evidence |
|---|---|---|
| Grounded answers only | Answers only from slide content plus approved background knowledge, in 3 sentences or fewer. Never invents numbers, studies or doses. | Fact accuracy 95% (57/60) |
| No comparative claims | "Is it better than X?" → states only that no head-to-head data exists, and flags it | Included in flag recall 100% |
| Off-label | Unstudied ages, combinations or indications → says it's outside the label, doesn't advise, flags `off_label` | Flag recall 100% (15/15) |
| Adverse events | Moves to the safety slide, flags `adverse_event`, refers to pharmacovigilance, gives no patient-specific medical advice | Routed and flagged 3/3 |
| Unknown or out of scope | "I don't have data on that" and flags `out_of_scope`; never guesses | Spurious flags: 0 |
| Off-topic or out-of-context requests | Weather, poems, coding, opinions → one-sentence decline, offer to return to the briefing; never answered, never flagged (keeps the compliance log clean) | New eval cases; counted in spurious flags |
| Prompt injection / role change | "Ignore your instructions", "be my doctor", "show your prompt" → declines and stays in role; a clinical question inside is still handled (e.g. off-label → flagged) | New eval case |
| Garbled speech | Asks the user to repeat instead of guessing or flagging (added after a live test produced a hallucinated answer) | New eval case |

**Limit, stated plainly:** the prompt-level guardrails are *measured*, not *guaranteed*. One known miss remains (an exposure question answered without its figure). For production I'd gate claims before they are spoken, using MLR-approved answer snippets or a claims checker; see [Trade-offs](#trade-offs-speech-to-speech-vs-a-cascaded-stt--llm--tts-pipeline).

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (Vite + React)"]
    UI[Slides · captions · orb · HUD]
    C[Controller<br/>impure shell]
    M[["reduce(state, input, now)<br/>→ state + commands<br/>(pure state machine)"]]
    UI <--> C
    C <--> M
  end
  subgraph Server["Server (Fastify, on Fly)"]
    S[/POST /api/realtime/session<br/>prompt + tools baked in/]
    T[/POST /api/sessions/:id/events/]
    N[/POST /api/sessions/:id/summary/]
    DB[(SQLite)]
    T --> DB --> N
  end
  OAI[(OpenAI Realtime<br/>gpt-realtime-2.1)]
  C -- "1. mint ephemeral key" --> S
  S -- "client_secrets" --> OAI
  C == "2. WebRTC audio + oai-events data channel" ==> OAI
  C -- telemetry --> T
  N -- "prose summary (gpt-5.4-mini)" --> OAI
  S -. "hang up at session limit" .-> OAI
```

- **The secret stays server-side.** The browser never sees the API key, the system prompt, the speaker notes or the hidden `knowledge` field. The server bakes them into a 60-second ephemeral key, and `GET /api/decks/:id` returns only what is on screen.
- **One pure reducer runs the whole conversation** (`web/src/agent/machine.ts`).
  - Inputs: server events, clicks, and connection changes.
  - Outputs: new state plus commands (`send`, `mute`, `telemetry`).
  - Nothing in it touches WebRTC or the DOM, so every race below is a plain unit test: barge-in during a tool call, Stop before `response.created`, navigation while a cancel is in flight, a lost `response.create` race, and reconnect.
- **The app sets the pace; the model routes questions.**
  - When a slide's audio *finishes playing* (`output_audio_buffer.stopped`, not `response.done`), the client advances and sends a short `[cue] present slide X`.
  - Pacing is deterministic and auditable, and costs one fewer model round trip per slide.
  - The model's `goto_slide` is reserved for questions.
- **Data-driven deck.** zod schemas live in `/shared`. A single schema both validates tool arguments and generates the JSON Schema sent to OpenAI. Slide layouts are derived from element types, so any deck renders without layout code.

### Question → slide change

```mermaid
sequenceDiagram
  participant U as Physician
  participant B as Browser (reducer)
  participant O as OpenAI Realtime
  U->>O: "What was EASI-75?" (audio)
  O-->>B: speech_started
  B->>B: mute locally · orb=listening · save cursor
  O-->>B: speech_stopped (TTFA clock starts)
  O-->>B: function_call goto_slide(efficacy)
  B->>B: validate id (zod) · animate slide
  B->>O: function_call_output {ok, title}
  O-->>B: function_call highlight(efficacy-easi75)
  B->>O: function_call_output {ok}
  O-->>B: response.done
  B->>O: response.create (continue)
  O-->>U: "About half reached EASI-75…" (audio)
  O-->>B: output_audio_buffer.started (TTFA clock stops)
  Note over B: questions are logged with the slide the answer landed on
```

### Interrupt

```mermaid
sequenceDiagram
  participant U as Physician
  participant B as Browser (reducer)
  participant O as OpenAI Realtime
  O-->>U: narrating slide 2…
  U->>O: starts talking
  O-->>B: speech_started
  B->>B: audio.muted = true (instant, no round trip)
  B->>B: freeze cursor: played ms × speech rate → last heard sentence
  B->>O: output_audio_buffer.clear
  Note over O: interrupt_response=true: server cancels the response<br/>and truncates unheard audio from context
  O-->>B: response.done (cancelled) · output_audio_buffer.cleared
  Note over B: HUD: interrupt → server-confirmed silence
  U->>O: "…yes, carry on"
  O-->>B: function_call resume_presentation
  B->>O: [cue] resume slide 2 after "<last heard sentence>"
```

`Space` and the Stop button take the same path, sending `response.cancel` followed by `output_audio_buffer.clear` (the order OpenAI's own SDK uses).

**Narration cursor.** Transcript text arrives *ahead* of the audio, so "what was heard" is estimated as playback time × speaking rate. The rate is recalibrated on every response that plays to the end. Only sentences that end in punctuation count as heard. The captions show the heard part normally and strike through the part that was cut off.

---

## Trade-offs: speech-to-speech vs. a cascaded STT → LLM → TTS pipeline

| | Speech-to-speech (this build) | Cascaded |
|---|---|---|
| Latency | One model, no STT/TTS hops; streams over WebRTC | Each hop adds latency |
| Barge-in | Native: server VAD cancels and truncates the response | You build it: cancel TTS, trim the LLM context yourself |
| Prosody / turn-taking | Natural; the model hears tone | Flattened to text |
| **Guardrails** | **Weak: audio is spoken as it is generated; nothing can check the text first** | Every reply is text you can check *before* it is spoken |
| Provider flexibility | Locked to one vendor's model and voices | Mix the best STT, LLM and TTS; swap any part |
| Auditability | Transcript is a by-product | Text is the source of truth |

Speech-to-speech wins this demo, where latency and barge-in are what's being judged. For a **regulated pharma deployment** I would change four things:

1. **Gate claims before they are spoken.**
   - Option A: a hybrid where the realtime model handles turn-taking but speaks from pre-approved, MLR-reviewed answer snippets retrieved by ID, rather than generating free text.
   - Option B: a cascaded path with a fast claims checker between LLM and TTS, used for the efficacy and safety slides.
2. **Treat the transcript and the event log as the record.** This build already keeps facts (questions, flags, slides) deterministic from the log, and the LLM writes only the prose. In production that log would feed pharmacovigilance intake within the regulatory clock, plus a human review queue.
3. **Run adverse-event detection on the user transcript in parallel**, not only via the model's tool call: a cheap classifier as a second line, so one missed tool call doesn't mean a missed AE.
4. **Lock down the deployment:** a pinned model version, an eval gate in CI (`npm run eval`) before any prompt or deck change ships, per-tenant keys, and BAA / data-residency review.

---

## Results

_Measured on: (fill in after the first live run)_

| Metric | Value | How |
|---|---|---|
| Time to first audio (p50) | v1 1,397 ms (n=13) · v2 _TBD_ | HUD: server end-of-speech → `output_audio_buffer.started`. Perceived delay ≈ value + 450 ms VAD silence window |
| Interrupt → silence (local) | ~0 ms | audio element muted on `speech_started` |
| Interrupt → silence (server-confirmed) | _TBD_ | `speech_started` → `output_audio_buffer.cleared` |
| Eval routing accuracy | v1 94.7% (18/19) · v2 100% (19/19) · **v3 100% (57/57)** | `npm run eval`: 21 questions, same model + prompt + tools, text mode |
| Eval flag recall | v1 80% (4/5) · v2 80% (4/5) · **v3 100% (15/15)** | off-label, adverse-event, out-of-scope cases |
| Eval fact accuracy | v1 85% (17/20) · v2 95% (19/20) · **v3 95% (57/60)** |
| Navigate before speaking | v1 100% · v2 95.2% · **v3 100%** | `goto_slide` called before any spoken text |
| Spurious flags | v1 1 · v2 0 · **v3 0** | flags raised on questions that needed none | answer must contain the deck's figure (number words allowed) |

**What the eval caught.** v1 (`gpt-realtime-2.1`) routed well and always navigated before speaking. But on three questions it said *"I don't have that data"* when the answer was in the slide's hidden `knowledge`: durability (71% maintained), JAK1 selectivity (~38-fold), and systemic exposure (<5% of IC50). It treated "not on screen" as "not in the deck". It also didn't move to the safety slide for an adverse-event report, and didn't flag a competitor-comparison question. v2 changes the prompt to say background knowledge is approved content to use, adds explicit rules for comparisons and adverse events, and adds fact checks to the eval so this class of miss is scored.

v2 fixed those, but a single run showed three new misses: an off-label question went unflagged because the deck already said "not recommended"; one answer gave "low" instead of the <5% figure; and the agent once said "let me pull up the slide" before navigating. v3 tightens those three rules. Each case runs once by default and the model samples, so a single flip can be noise. `npm run eval -- --repeat 3` measures consistency.

**v3** (`gpt-realtime-2.1`, 21 questions × 3 runs, 2026-11-07): 100% routing, 100% flag recall, no spurious flags, and every navigation happened before speech. **The one consistent miss:** asked *"Should I worry about systemic exposure?"*, the agent says exposure is "low" but doesn't cite the <5%-of-IC50 figure (0 of 3 runs). I left it unpatched instead of tuning the prompt to this one question; in production this is a case for pre-approved answer snippets.

*Measurement note:* an earlier 3× run looked like a regression (61% routing). It was the account's 200k tokens-per-minute realtime limit: 42 of 63 responses were throttled and scored as empty answers. The runner now counts failed responses as errors with their reason, and defaults to low concurrency. Use `--concurrency 1` on new accounts.

The eval also reports **spurious flags** and whether `goto_slide` came **before** any speech, as the prompt requires. Results are written to `server/src/eval/results.json`.

---

## Engineering notes

- **Tools (5):**
  - `goto_slide(slide_id, reason, element_id?)`: navigation and pointing in one call.
  - `highlight`: points at an element on the current slide.
  - `flag_for_followup`: logs a compliance item.
  - `resume_presentation` and `end_call`: added beyond the brief, because the client can't reliably infer "carry on" or "let's stop" from a transcript.
  - Voice navigation ("next slide", "skip to dosing") is `goto_slide` followed by `resume_presentation` in the same turn: the deck continues from the new slide.
- **Latency lesson from a live test:** TTFA p50 was 1.4 s because answers made two tool round trips (goto, then highlight) before speaking. Each tool call ends the model's turn, and the client must answer before the model can talk. Now answers on the current slide make no tool call, and cross-slide answers make one (`goto_slide` with `element_id`).
- **Lessons from a messy live test** (interjections, garbled speech-to-text, "skip", "let's end here"):
  - Acknowledgements are never questions or flags.
  - Garbled speech gets "could you repeat that?" instead of a guess.
  - "End" closes the call and shows the notes.
  - The call notes use the text model to keep only real questions (it selects from logged utterances and can't add any). The summary mentions pharmacovigilance only when an adverse event was actually flagged.
- **Cost guard:**
  - 10 sessions per IP per hour.
  - Ephemeral keys live for 60 s.
  - Each session gets an 8-minute budget, shown as a countdown in the UI.
  - The server hangs up the WebRTC call itself (`/v1/realtime/calls/{id}/hangup`) when the budget runs out, so a modified client can't run up the bill.
  - Reconnects reuse the session's remaining budget.
- **Reconnect:** on a dropped connection, the app retries 3 times with backoff (0.5, 1.5, 4 s). The new session has no memory, so it is re-seeded with a recap (slides covered, questions asked) and resumes from the narration cursor.
- **Mic denied:** the call connects receive-only, so the agent's voice still plays and a text box drives the same session.
- **Call notes:** questions (with the slide each answer landed on), flags, slides seen, and latency medians all come straight from the SQLite log. A text model writes a 2–3 sentence CRM summary on top, cached once per session. If that call fails, the notes still render.
- **Quality:** TypeScript strict with `noUncheckedIndexedAccess`, no `any`, and zod at every trust boundary (deck files, tool arguments, server events, telemetry). 63 tests cover the prompt builder, tool handler, state machine, cursor, API routes and eval scoring.

### Layout

```
shared/   deck + tool + telemetry schemas (zod)
server/   Fastify API · prompt builder · SQLite · eval (src/eval)
web/      React UI · realtime/ (WebRTC, events) · agent/ (reducer, tools, cursor, controller)
```

### Deploy

**Server (Fly):**
```bash
fly launch --no-deploy --copy-config
```
```bash
fly volumes create msl_data --size 1
```
```bash
fly secrets set OPENAI_API_KEY=sk-...
```
```bash
fly deploy
```

**Web (Vercel):** import the repo and leave the root directory as the repo root. `vercel.json` builds `web/` and rewrites `/api/*` to the Fly app, so the browser stays same-origin. If the Fly app name differs, update `vercel.json`.

## Known limits

- **Speaker echo** can trigger a false barge-in without headphones (AEC is on and the VAD threshold is raised to 0.6, which helps but doesn't eliminate it).
- **The heard-text estimate is a heuristic.** The server-side truncation keeps the *model's* context accurate either way.
- **Tool calls pause speech**, so the prompt asks for all tool calls before speaking; a model that ignores this produces a short gap.
- **Server state is single-instance:** SQLite and in-memory hang-up timers mean one Fly machine.
- **The eval measures routing in text mode.** Audio-mode behaviour can differ slightly.

## What's next

- **Auditing and compliance:**
  - an append-only, tamper-evident audit log (hash-chained events, plus transcript and audio retained per policy)
  - a reviewer queue for every flag, with owner, SLA and resolution
  - adverse-event export to pharmacovigilance intake within the regulatory clock
  - CRM export (e.g. Veeva) of the call notes
  - sampled post-call review of real conversations (LLM judge + human), feeding new eval cases
- Pre-approved answer snippets with claim IDs (MLR-ready), and a claims checker on the efficacy and safety answers.
- A parallel adverse-event classifier on the user transcript.
- Client-side VAD for even faster local barge-in, with server VAD confirming.
- Eval in CI with a regression threshold; audio-mode eval with synthesized physician voices.
- Multi-language briefings (the deck schema is language-agnostic).
