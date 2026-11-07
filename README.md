# MSL·Live: an AI Medical Science Liaison you can interrupt

A voice agent briefs a physician on **Lumirexa™ (tavrocitinib) cream 1%**, a fictional topical JAK1 inhibitor for moderate-to-severe atopic dermatitis.

- It presents six slides on its own.
- When the physician asks a question, it jumps to the slide that holds the answer.
- It stops the moment the physician starts talking, and later resumes from the last sentence they actually heard.
- It flags adverse events and off-label questions as they happen.

> **Fictional product. Synthetic data. Demo only.** "Lumirexa" and "tavrocitinib" match no real drug. The `-citinib` ending follows the real naming convention for JAK inhibitors, so the name reads as plausible to clinicians.

- **Live:** `https://msl-live.vercel.app` _(placeholder until deployed)_
- **Loom:** _(placeholder)_

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
| Time to first audio (p50) | _TBD_ | HUD: server end-of-speech → `output_audio_buffer.started`. Perceived delay ≈ value + 450 ms VAD silence window |
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

- Pre-approved answer snippets with claim IDs (MLR-ready), and a claims checker on the efficacy and safety answers.
- A parallel adverse-event classifier on the user transcript.
- Client-side VAD for even faster local barge-in, with server VAD confirming.
- Eval in CI with a regression threshold; audio-mode eval with synthesized physician voices.
- Multi-language briefings (the deck schema is language-agnostic).
