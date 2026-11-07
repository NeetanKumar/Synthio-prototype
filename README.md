# MSL·Live: an AI Medical Science Liaison you can interrupt

A voice agent briefs a physician on **Lumirexa™ (tavrocitinib) cream 1%**, a fictional topical JAK1 inhibitor.
- It presents six slides on its own.
- It jumps to the right slide when asked a question.
- It stops the instant the physician speaks.
- It resumes from the last sentence they actually heard.
- It flags adverse events and off-label questions as they happen.

> **Fictional product. Synthetic data. Demo only.** Neither name matches a real drug.

**Live:** `https://msl-live.vercel.app` _(placeholder)_ · **Loom:** _(placeholder)_ · **Docs:** [architecture](docs/architecture.md) · [eval](docs/eval.md) · [deploy](docs/deploy.md)

## Run it

```bash
cp .env.example .env   # add OPENAI_API_KEY
npm install && npm run dev
```

Open http://localhost:5173, click **Start briefing**, and use headphones.
- **Speak** to interrupt, ask a question, or say "next slide" / "let's end here".
- **`Space`** stops the agent; **`←` `→`** navigate; **`D`** opens the latency HUD.
- **`?deck=voice-latency`** loads a second deck: swapping the JSON swaps the topic.
- **Checks:** `npm test` (76 tests) · `npm run typecheck` · `npm run eval`

## Stack

- **Voice:** OpenAI Realtime (`gpt-realtime-2.1`), browser ↔ OpenAI over WebRTC; events and tool calls on the data channel.
- **Web:** React + Vite.
- **Server:** Fastify + SQLite. It mints ephemeral keys (the prompt never reaches the browser), logs telemetry and writes call notes.
- **Conversation logic:** one pure, unit-tested state machine.
- Details in [docs/architecture.md](docs/architecture.md).

## Guardrails

A speech-to-speech model speaks as it generates, so nothing can check its text before it's heard. I therefore split guardrails into two kinds: **enforced in code**, and **instructed in the prompt and measured by the eval**.

**Enforced in code (deterministic)**
- **Server-side secrets:** the API key, prompt and hidden knowledge stay on the server. The browser gets a 60-second ephemeral key.
- **Validated tool calls:** every tool argument is checked with zod; invalid slide or element IDs are rejected.
- **Audit trail:** every compliance flag is shown on screen and logged with timestamp and slide.
- **Call notes from the log:** facts come from the event log. The model only writes the prose and *selects* questions from logged utterances; it can't add any.
- **Cost limits:** per-IP rate limit, plus a session cap enforced by a **server-side hang-up**.

**Instructed in the prompt, measured by the eval** (v3: 21 questions × 3 runs)

| Rule | Behaviour | Evidence |
|---|---|---|
| Grounded answers | Only from deck content + approved background knowledge; never invents numbers | Facts 95% (57/60) |
| Off-label | Says it's outside the label, doesn't advise, flags it | Flag recall 100% (15/15) |
| Adverse events | Goes to safety, flags, refers to pharmacovigilance, no patient-specific advice | 3/3 |
| No comparative claims | States only that no head-to-head data exists, flags it | 3/3 |
| Out of scope / off-topic / injection | "No data" + flag for product gaps; declines and stays in role for off-topic or "ignore your instructions" | 0 spurious flags |
| Garbled speech | Asks the user to repeat instead of guessing | Eval case |

**Limit:** the prompt rules are *measured*, not *guaranteed*. One known miss remains (see [eval](docs/eval.md)).

## Results

| Metric | Value |
|---|---|
| Slide routing (eval, 3 runs) | **100%** (57/57) |
| Compliance-flag recall | **100%** (15/15) |
| Answers containing the deck's figure | **95%** (57/60) |
| Interrupt → silence | **~0 ms** local (muted on speech detection); server-confirmed _TBD_ |
| Time to first audio (p50) | 1.4 s before the one-tool-turn fix; _re-measure TBD_ |

The eval caught real bugs: the agent said "no data" when the answer was in hidden knowledge, and it skipped some flags. The prompt was fixed, and scores rose from 94.7% → 100% routing and 85% → 95% facts. Full story in [docs/eval.md](docs/eval.md).

## Trade-off: speech-to-speech vs. cascaded STT → LLM → TTS

- **Why speech-to-speech here:** lower latency and native barge-in, which is what this demo is judged on.
- **What it gives up:**
  - text-level guardrails: nothing can be checked before it's spoken
  - provider flexibility
- **What I'd change for production in pharma:**
  - Gate claims before they're spoken, using MLR-approved answer snippets or a claims checker on efficacy and safety answers.
  - Run a parallel adverse-event classifier on the transcript.
  - Pin the model version, and gate every prompt or deck change on the eval in CI.

## Known limits

- **Speaker echo** can cause false interruptions without headphones.
- **The heard-text estimate is a heuristic,** but server-side truncation keeps the model's context correct.
- **The server is single-instance:** SQLite plus in-memory hang-up timers.
- **The eval runs in text mode;** audio behaviour can differ slightly.

## Future scope

**Compliance and audit**
- **Claim-level traceability.** Every spoken sentence is linked to an MLR-approved claim ID from the deck. A reviewer can replay any call and see which approved claim backed each sentence, and which sentences had no backing.
- **Structured adverse-event intake.** Capture the four minimum elements of a valid report (patient, reporter, product, event) in the conversation, then draft an ICH E2B(R3) case for pharmacovigilance within the regulatory clock.
- **Tamper-evident audit log.** Hash-chained events, plus transcript and audio retained per policy. Every flag goes to a reviewer queue with owner and SLA.
- **Claims gate before speech.** Answers about efficacy and safety are spoken from pre-approved snippets, or passed through a claims checker, instead of free generation.

**Product**
- **Medical-affairs insights.** Aggregate questions across calls into themes, e.g. "38% of dermatologists ask about durability beyond week 16". That is a core MSL deliverable, and today it's done by hand.
- **Personalised briefings.** Adapt depth and order to specialty and history from the CRM: an allergist hears more mechanism, a returning physician skips what they've seen. Call notes go back to the CRM (e.g. Veeva).
- **Phone and human handoff.** Physicians call a number over SIP, which OpenAI Realtime supports. The agent transfers to a human MSL with context (`calls/{id}/refer`) when asked or when a flag needs a person.
- **Patient mode.** The same engine with a lay-language deck, a reading-level check, stricter adverse-event capture, and explicit consent.
- **Multilingual.** The same approved content in the physician's language; the deck schema is language-agnostic.

**Quality**
- **Eval as a release gate.** Run the eval in CI on every prompt or deck change, plus an audio-mode eval with synthesized physician voices, accents and background noise, and a red-team suite (prompt injection, off-label fishing).
- **Faster barge-in.** Client-side voice detection mutes even before the server detects speech; server detection confirms.
