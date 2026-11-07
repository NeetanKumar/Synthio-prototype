# Architecture

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
  N -- "call-notes summary (gpt-5.4-mini)" --> OAI
  S -. "hang up at session limit" .-> OAI
```

## Key decisions

- **The secret stays server-side.**
  - The browser never sees the API key, the system prompt, the speaker notes or the hidden `knowledge` field.
  - The server bakes them into a 60-second ephemeral key, and `GET /api/decks/:id` returns only what is on screen.
- **One pure reducer runs the whole conversation** (`web/src/agent/machine.ts`).
  - Inputs: server events, clicks and connection changes.
  - Outputs: new state plus commands (`send`, `mute`, `telemetry`, `end_call`).
  - Nothing in it touches WebRTC or the DOM, so every race is a plain unit test: barge-in during a tool call, Stop before `response.created`, navigation while a cancel is in flight, a lost `response.create` race, reconnect.
- **The app sets the pace; the model routes questions.**
  - When a slide's audio *finishes playing* (`output_audio_buffer.stopped`, not `response.done`), the client advances and sends a short `[cue] present slide X`.
  - Pacing stays deterministic and auditable, and each slide needs one fewer model round trip.
- **Data-driven deck.**
  - zod schemas in `/shared` validate decks and tool arguments, and generate the JSON Schema sent to OpenAI.
  - Layouts are derived from element types, so any deck renders without layout code.
- **One tool turn before speaking.**
  - Each tool call ends the model's turn, and the client must reply before the model can talk.
  - Answers on the current slide make no tool call; cross-slide answers make one (`goto_slide` with `element_id`).
  - Two tool calls per answer gave a 1.4 s median time-to-first-audio in a live test.

## Tools

| Tool | Purpose |
|---|---|
| `goto_slide(slide_id, reason, element_id?)` | Navigate, and optionally point, in one call |
| `highlight(element_id)` | Laser pointer on the current slide |
| `flag_for_followup(type, summary)` | Compliance log: `adverse_event`, `off_label`, `out_of_scope` |
| `resume_presentation()` | Hand control back to the script. After `goto_slide` in the same turn it continues from that slide ("next slide") |
| `end_call()` | Goodbye plays, then the call closes and the notes open |

`resume_presentation` and `end_call` go beyond the brief: the client can't reliably infer "carry on" or "let's stop" from a transcript.

## Question → slide change

```mermaid
sequenceDiagram
  participant U as Physician
  participant B as Browser (reducer)
  participant O as OpenAI Realtime
  U->>O: "What was EASI-75?" (audio)
  O-->>B: speech_started
  B->>B: mute locally · orb=listening · save cursor
  O-->>B: speech_stopped (TTFA clock starts)
  O-->>B: function_call goto_slide(efficacy, element_id=efficacy-easi75)
  B->>B: validate (zod) · animate slide · point at the bar
  B->>O: function_call_output {ok, title}
  O-->>B: response.done
  B->>O: response.create (continue)
  O-->>U: "About half reached EASI-75…" (audio)
  O-->>B: output_audio_buffer.started (TTFA clock stops)
  Note over B: the question is logged with the slide the answer landed on
```

## Interrupt

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
  U->>O: "…yes, carry on"
  O-->>B: function_call resume_presentation
  B->>O: [cue] resume slide 2 after "<last heard sentence>"
```

- `Space` and the Stop button send `response.cancel` followed by `output_audio_buffer.clear` (the order OpenAI's own SDK uses).
- **Narration cursor:**
  - Transcript text arrives *ahead* of the audio, so "what was heard" is estimated as playback time × speaking rate.
  - The rate is recalibrated on every response that plays to the end, and only sentences ending in punctuation count as heard.
  - The captions strike through the part that was cut off.

## Engineering notes

- **Cost guard:**
  - 10 sessions per IP per hour; ephemeral keys live 60 s.
  - Each session has an 8-minute budget, shown as a UI countdown. The server hangs up the call itself (`/v1/realtime/calls/{id}/hangup`), so a modified client can't run up the bill.
- **Reconnect:** 3 retries with backoff. The new session has no memory, so it is re-seeded with a recap and resumes from the narration cursor.
- **Mic denied:** the call connects receive-only; a text box drives the same session.
- **Call notes:**
  - Questions, flags, slides seen and latency medians come from the SQLite event log.
  - One text-model call selects which logged utterances were real questions and writes a 2–3 sentence summary, cached per session. If it fails, the notes still render.
- **Quality:** TypeScript strict with `noUncheckedIndexedAccess`, no `any`, and zod at every trust boundary (deck files, tool arguments, server events, telemetry).

## Layout

```
shared/   deck + tool + telemetry schemas (zod)
server/   Fastify API · prompt builder · SQLite · eval (src/eval)
web/      React UI · realtime/ (WebRTC, events) · agent/ (reducer, tools, cursor, controller)
```
