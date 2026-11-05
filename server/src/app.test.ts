import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallNotes, RealtimeSessionResponse } from '@msl/shared';
import { buildApp } from './app.ts';
import { Store } from './db.ts';
import { loadDecks } from './decks.ts';
import type { OpenAIClient } from './openai.ts';

process.env.LOG_LEVEL = 'silent';

function setup(over: { sessionsPerHour?: number; maxSessionMs?: number; failSummary?: boolean } = {}) {
  const calls = { mint: [] as object[], hangup: [] as string[], complete: 0 };
  const openai: OpenAIClient = {
    mintSecret: async (s) => {
      calls.mint.push(s);
      return { value: 'ek_test', expires_at: 123 };
    },
    hangup: async (id) => void calls.hangup.push(id),
    complete: async () => {
      calls.complete += 1;
      if (over.failSummary) throw new Error('model down');
      return 'The physician asked about efficacy.';
    },
  };
  const appP = buildApp({
    decks: loadDecks(),
    openai,
    store: new Store(':memory:'),
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    webOrigin: 'http://localhost:5173',
    maxSessionMs: over.maxSessionMs ?? 60_000,
    sessionsPerHour: over.sessionsPerHour ?? 10,
    ipSalt: 'x',
  });
  return { appP, calls };
}

async function mint(app: Awaited<ReturnType<typeof buildApp>>, body: object = { deckId: 'lumirexa' }) {
  return app.inject({ method: 'POST', url: '/api/realtime/session', payload: body });
}

afterEach(() => vi.useRealTimers());

describe('POST /api/realtime/session', () => {
  it('mints a secret with the server-side prompt and returns no instructions', async () => {
    const { appP, calls } = setup();
    const app = await appP;
    const res = await mint(app);
    expect(res.statusCode).toBe(200);
    const body = res.json<RealtimeSessionResponse>();
    expect(body.clientSecret).toBe('ek_test');
    expect(res.body).not.toContain('instructions');
    expect(calls.mint[0]).toHaveProperty('instructions');
  });

  it('rejects unknown decks and bad bodies', async () => {
    const app = await setup().appP;
    expect((await mint(app, { deckId: 'nope' })).statusCode).toBe(404);
    expect((await mint(app, { deckId: 'lumirexa', vad: 'loud' })).statusCode).toBe(400);
  });

  it('rate-limits per IP', async () => {
    const app = await setup({ sessionsPerHour: 2 }).appP;
    expect((await mint(app)).statusCode).toBe(200);
    expect((await mint(app)).statusCode).toBe(200);
    expect((await mint(app)).statusCode).toBe(429);
  });

  it('reconnect reuses the session id and only the remaining time budget', async () => {
    const app = await setup().appP;
    const first = (await mint(app)).json<RealtimeSessionResponse>();
    const again = (await mint(app, { deckId: 'lumirexa', sessionId: first.sessionId })).json<RealtimeSessionResponse>();
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.maxSessionMs).toBeLessThanOrEqual(first.maxSessionMs);
  });
});

describe('telemetry and call notes', () => {
  it('stores validated events and builds notes from them', async () => {
    const { appP, calls } = setup();
    const app = await appP;
    const { sessionId } = (await mint(app)).json<RealtimeSessionResponse>();
    const events = [
      { type: 'session', phase: 'start', at: 0 },
      { type: 'slide_change', from: 'unmet-need', to: 'efficacy', by: 'agent', at: 5000 },
      { type: 'question', text: 'What was EASI-75?', slideId: 'efficacy', via: 'voice', at: 6000 },
      { type: 'flag', flag: 'adverse_event', summary: 'Patient had a rash', slideId: 'safety', at: 9000 },
      { type: 'interruption', via: 'voice', slideId: 'unmet-need', at: 4000 },
      { type: 'latency', metric: 'ttfa', ms: 700, at: 6500 },
      { type: 'latency', metric: 'ttfa', ms: 900, at: 7500 },
    ];
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/events`, payload: { events } })).statusCode).toBe(200);

    const notes = (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/summary` })).json<CallNotes>();
    expect(notes.questions).toEqual([{ text: 'What was EASI-75?', slideId: 'efficacy', slideTitle: 'LUMEN-1 & LUMEN-2: pooled week 16 results', via: 'voice' }]);
    expect(notes.flags).toHaveLength(1);
    expect(notes.slidesVisited).toEqual(['unmet-need', 'efficacy']);
    expect(notes.interruptions).toBe(1);
    expect(notes.latency.ttfaP50).toBe(800);
    expect(notes.narrative).toContain('physician');

    // Summary is cached: a second call costs no LLM call.
    await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/summary` });
    expect(calls.complete).toBe(1);
  });

  it('rejects malformed events and unknown sessions', async () => {
    const app = await setup().appP;
    const { sessionId } = (await mint(app)).json<RealtimeSessionResponse>();
    const bad = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/events`, payload: { events: [{ type: 'hack', at: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/sessions/00000000-0000-4000-8000-000000000000/events`,
      payload: { events: [{ type: 'session', phase: 'start', at: 0 }] },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('call notes still work when the text model fails', async () => {
    const app = await setup({ failSummary: true }).appP;
    const { sessionId } = (await mint(app)).json<RealtimeSessionResponse>();
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/summary` });
    expect(res.statusCode).toBe(200);
    expect(res.json<CallNotes>()).toMatchObject({ narrative: null, questions: [], slidesVisited: ['unmet-need'] });
  });
});

describe('server-side session limit', () => {
  it('hangs up the registered call after the budget plus grace', async () => {
    const { appP, calls } = setup({ maxSessionMs: 1000 });
    const app = await appP;
    const { sessionId } = (await mint(app)).json<RealtimeSessionResponse>();
    // Fake only setTimeout: Fastify's inject relies on real setImmediate/nextTick.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/call`, payload: { callId: 'rtc_abc123' } });
    expect(res.statusCode).toBe(200);
    expect(calls.hangup).toEqual([]);
    vi.advanceTimersByTime(1000 + 15_000 + 10);
    expect(calls.hangup).toEqual(['rtc_abc123']);
  });
});
