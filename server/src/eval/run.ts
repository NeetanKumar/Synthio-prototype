// Routing eval: runs each question through the SAME realtime model, instructions
// and tools as the live app, in text-only mode over WebSocket, and checks which
// slide the agent navigates to (and which compliance flags it raises).
//
//   npm run eval                 # all cases
//   npm run eval -- --model gpt-realtime-2.1-mini
//
// Each case gets a fresh session so answers can't leak into each other.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CUE_PREFIX } from '@msl/shared';
import { loadDecks } from '../decks.ts';
import { buildSessionConfig } from '../sessionConfig.ts';
import { scoreCase, summarize, type CaseResult, type EvalCase, type ToolCall } from './score.ts';

try {
  process.loadEnvFile(join(import.meta.dirname, '../../../.env'));
} catch {
  /* env from the shell */
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MODEL = arg('model') ?? process.env.REALTIME_MODEL ?? 'gpt-realtime-2.1';
const CONCURRENCY = Number(arg('concurrency') ?? 4);
const TIMEOUT_MS = 45_000;
const MAX_ROUNDS = 4;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

const spec = JSON.parse(readFileSync(join(import.meta.dirname, 'questions.json'), 'utf8')) as { deck: string; startSlide: string; cases: EvalCase[] };
const found = loadDecks().get(spec.deck);
if (!found) throw new Error(`deck ${spec.deck} not found`);
const deck = found; // re-bound so closures below see a non-undefined type
const config = buildSessionConfig(deck, { model: MODEL, voice: 'marin', vad: 'server' });
const slideTitle = (id: string) => deck.slides.find((s) => s.id === id)?.title;

function runCase(c: EvalCase): Promise<CaseResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const calls: ToolCall[] = [];
    let answer = '';
    let textBeforeFirstGoto = false;
    let rounds = 0;
    let callsThisRound = 0;
    let settled = false;

    const send = (e: object) => ws.send(JSON.stringify(e));
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(scoreCase(c, spec.startSlide, calls, answer.trim(), textBeforeFirstGoto, error));
    };
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);

    ws.on('open', () => {
      // Same instructions/tools as production; only the output modality differs.
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: config.instructions,
          tools: config.tools,
          tool_choice: 'auto',
          output_modalities: ['text'],
          ...('reasoning' in config ? { reasoning: config.reasoning } : {}),
        },
      });
    });

    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw)) as Record<string, unknown> & { type: string };
      switch (ev.type) {
        case 'session.updated':
          if (rounds > 0) break;
          rounds = 1;
          // Same state the live app is in mid-presentation: slide 1 on screen.
          send({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `${CUE_PREFIX} slide ${spec.startSlide} is on screen and has just been presented.` }] },
          });
          send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: c.q }] } });
          send({ type: 'response.create' });
          break;
        case 'response.output_text.delta':
          if (!calls.some((t) => t.name === 'goto_slide')) textBeforeFirstGoto ||= String(ev.delta ?? '').trim().length > 0;
          answer += String(ev.delta ?? '');
          break;
        case 'response.function_call_arguments.done': {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(String(ev.arguments)) as Record<string, unknown>;
          } catch {
            /* scored as-is */
          }
          const name = String(ev.name);
          calls.push({ name, args });
          callsThisRound += 1;
          // Mirror the client's tool handler closely enough for the model to continue.
          let output: object = { ok: true };
          if (name === 'goto_slide') {
            const id = String(args.slide_id ?? '');
            output = slideTitle(id) ? { ok: true, slide_id: id, title: slideTitle(id) } : { ok: false, error: `no slide "${id}"`, valid_slide_ids: deck.slides.map((s) => s.id) };
          }
          send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(output) } });
          break;
        }
        case 'response.done':
          if (callsThisRound > 0 && rounds < MAX_ROUNDS) {
            rounds += 1;
            callsThisRound = 0;
            send({ type: 'response.create' });
          } else finish();
          break;
        case 'error':
          finish(JSON.stringify((ev as { error?: unknown }).error));
          break;
      }
    });
    ws.on('error', (err) => finish(err.message));
  });
}

async function main() {
  console.log(`Eval: ${spec.cases.length} cases · deck ${deck.id} · model ${MODEL}\n`);
  const results: CaseResult[] = new Array(spec.cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < spec.cases.length) {
        const i = next++;
        results[i] = await runCase(spec.cases[i]!);
        const r = results[i]!;
        const mark = r.error ? '!' : r.routingOk === false || r.flagOk === false ? '✗' : '✓';
        console.log(`${mark} ${r.q}\n    → ${r.routedSlide}${r.expectedSlide ? ` (want ${r.expectedSlide})` : ''}${r.flags.length ? ` · flags: ${r.flags.join(',')}` : ''}${r.expectedFlag ? ` (want ${r.expectedFlag})` : ''}${r.error ? ` · ERROR ${r.error}` : ''}`);
      }
    }),
  );

  const summary = summarize(results);
  console.log('\n', summary);
  const out = { model: MODEL, deck: deck.id, ranAt: new Date().toISOString(), summary, results };
  writeFileSync(join(import.meta.dirname, 'results.json'), JSON.stringify(out, null, 2));
  console.log(`\nWrote server/src/eval/results.json`);
}

await main();
