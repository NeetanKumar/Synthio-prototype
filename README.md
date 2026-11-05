# MSL·Live: AI Medical Science Liaison (Synthio Labs take-home)

A voice agent presents a **fictional** topical drug (Lumirexa™ / tavrocitinib) to a physician. It routes questions to the right slide and can be interrupted mid-sentence.
All data is synthetic. Full write-up arrives in P2; see `PLAN.md` for the design.

## Run locally (2 commands)

```bash
cp .env.example .env   # then put your OPENAI_API_KEY in .env
npm install && npm run dev
```

Open http://localhost:5173, click **Start briefing**, and allow the microphone. Headphones are recommended so the agent doesn't hear itself.

- `Space` stops the agent (manual barge-in). `←` / `→` or the thumbnails navigate, and the agent follows.
- `?vad=semantic` switches to semantic VAD. `?deck=<id>` loads another deck.
- `npm test` runs the unit tests (prompt builder, tool handler, state machine). `npm run typecheck` runs strict TS across all packages.
