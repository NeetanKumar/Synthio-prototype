# Eval

`npm run eval -- --repeat 3 --concurrency 1`

- **What it does:** runs each physician question through the **same** realtime model, prompt and tools as the live app, in text mode, in a fresh session per question.
- **What it scores:**
  - slide routing
  - compliance flags, plus spurious flags
  - whether the answer contains the deck's figure
  - whether `goto_slide` came before any speech
  - conversation-control tools (navigation, resume, end)
- **Output:** `server/src/eval/results.json`.

## History

| | Routing | Flag recall | Facts | Navigate before speech | Spurious flags |
|---|---|---|---|---|---|
| v1 (1 run) | 94.7% (18/19) | 80% (4/5) | 85% (17/20) | 100% | 1 |
| v2 (1 run) | 100% (19/19) | 80% (4/5) | 95% (19/20) | 95.2% | 0 |
| v3 (3 runs) | 100% (57/57) | 100% (15/15) | 95% (57/60) | 100% | 0 |

**v1: what the eval caught.**
- On three questions the agent said *"I don't have that data"* although the answer was in the slide's hidden `knowledge`: durability (71% maintained), JAK1 selectivity (~38-fold), and systemic exposure (<5% of IC50). It treated "not on screen" as "not in the deck".
- It also didn't move to the safety slide for an adverse-event report, and didn't flag a competitor comparison.
- Fix: the prompt now says background knowledge is approved content to use, adds explicit rules for comparisons and adverse events, and the eval gained fact checks.

**v2.**
- New misses: an off-label question went unflagged because the deck already said "not recommended", an answer said "low" instead of the figure, and the agent once announced "let me pull up the slide" before navigating.
- v3 tightened all three rules.

**v3: the remaining miss.** For "Should I worry about systemic exposure?" the agent says "low" but doesn't cite the <5%-of-IC50 figure (0/3 runs). I left it unpatched rather than tune the prompt to one question; in production this is a case for pre-approved answer snippets.

**After a messy live test** (interjections, garbled speech-to-text, "skip", "let's end here"), I added cases for:
- voice navigation
- acknowledgements
- ending the call
- garbled speech
- off-topic requests
- prompt injection

## Measurement note

One 3× run looked like a regression (61% routing), but the agent hadn't changed:
- It was the account's 200k tokens-per-minute realtime limit: 42 of 63 responses were throttled and scored as empty answers.
- The runner now counts failed responses as errors with their reason, and defaults to low concurrency. Use `--concurrency 1` on new accounts.
