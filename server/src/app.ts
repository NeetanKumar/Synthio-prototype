import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { EventBatchSchema, toPublicDeck, type CallNotes, type Deck, type RealtimeSessionResponse } from '@msl/shared';
import type { Store } from './db.ts';
import { buildCallNotes, summaryPrompt } from './notes.ts';
import type { OpenAIClient } from './openai.ts';
import { buildSessionConfig } from './sessionConfig.ts';

export interface AppDeps {
  decks: Map<string, Deck>;
  openai: OpenAIClient;
  store: Store;
  model: string;
  voice: string;
  webOrigin: string;
  maxSessionMs: number;
  /** Max /realtime/session calls per IP per hour (reconnects count too). */
  sessionsPerHour: number;
  ipSalt: string;
  now?: () => number;
}

const SessionBody = z.object({
  deckId: z.string().max(64),
  vad: z.enum(['server', 'semantic']).default('server'),
  /** Present on reconnect: keep logging into the same session. */
  sessionId: z.string().uuid().optional(),
});

const CallBody = z.object({ callId: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/) });
const SessionParams = z.object({ id: z.string().uuid() });
const MAX_EVENTS_PER_SESSION = 3000;
const HANGUP_GRACE_MS = 15_000;

export async function buildApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  // trustProxy: behind Fly's proxy (and the Vercel rewrite) req.ip is the client from X-Forwarded-For.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true, bodyLimit: 256 * 1024 });
  await app.register(cors, { origin: deps.webOrigin.split(',') });
  await app.register(rateLimit, { global: false });

  const hashIp = (ip: string) => createHash('sha256').update(deps.ipSalt + ip).digest('hex').slice(0, 16);
  const hangupTimers = new Map<string, NodeJS.Timeout>();

  app.get('/api/health', async () => ({ ok: true }));

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => {
    const deck = deps.decks.get(req.params.id);
    if (!deck) return reply.code(404).send({ error: 'deck not found' });
    return toPublicDeck(deck);
  });

  // Mint an ephemeral key. The instructions and tools are baked into it here,
  // so the real API key and the prompt never reach the browser.
  app.post(
    '/api/realtime/session',
    { config: { rateLimit: { max: deps.sessionsPerHour, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = SessionBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const deck = deps.decks.get(body.data.deckId);
      if (!deck) return reply.code(404).send({ error: 'deck not found' });

      // Reconnects reuse the session (same log, same time budget) if it is still within its limit.
      const existing = body.data.sessionId ? deps.store.getSession(body.data.sessionId) : undefined;
      const reusable = existing && existing.deck_id === deck.id && now() - existing.created_at < deps.maxSessionMs;
      const sessionId = reusable ? existing.id : randomUUID();
      const remainingMs = reusable ? deps.maxSessionMs - (now() - existing.created_at) : deps.maxSessionMs;

      const session = buildSessionConfig(deck, { model: deps.model, voice: deps.voice, vad: body.data.vad });
      try {
        const secret = await deps.openai.mintSecret(session);
        if (!reusable) deps.store.createSession({ id: sessionId, deck_id: deck.id, created_at: now(), ip_hash: hashIp(req.ip) });
        const res: RealtimeSessionResponse = {
          sessionId,
          clientSecret: secret.value,
          expiresAt: secret.expires_at,
          model: deps.model,
          maxSessionMs: remainingMs,
        };
        return res;
      } catch (err) {
        req.log.error({ err }, 'mint secret failed');
        return reply.code(502).send({ error: 'the voice service is unavailable' });
      }
    },
  );

  // The browser reports its WebRTC call id; the server hangs up when the session
  // budget runs out, so the cost guard holds even if the client misbehaves.
  app.post('/api/sessions/:id/call', async (req, reply) => {
    const params = SessionParams.safeParse(req.params);
    const body = CallBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid request' });
    const session = deps.store.getSession(params.data.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    const { callId } = body.data;
    deps.store.addCall(callId, session.id, now());
    if (!hangupTimers.has(callId)) {
      const delay = Math.max(0, session.created_at + deps.maxSessionMs + HANGUP_GRACE_MS - now());
      const timer = setTimeout(() => {
        hangupTimers.delete(callId);
        deps.openai.hangup(callId).then(
          () => app.log.info({ callId }, 'session limit: call hung up'),
          (err: unknown) => app.log.warn({ err, callId }, 'hangup failed'),
        );
      }, delay);
      timer.unref();
      hangupTimers.set(callId, timer);
    }
    return { ok: true };
  });

  app.post('/api/sessions/:id/events', async (req, reply) => {
    const params = SessionParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid session id' });
    const batch = EventBatchSchema.safeParse(req.body);
    if (!batch.success) return reply.code(400).send({ error: 'invalid events' });
    const session = deps.store.getSession(params.data.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (deps.store.countEvents(session.id) + batch.data.events.length > MAX_EVENTS_PER_SESSION) {
      return reply.code(413).send({ error: 'event limit reached' });
    }
    deps.store.addEvents(session.id, batch.data.events);
    return { ok: true, stored: batch.data.events.length };
  });

  app.post(
    '/api/sessions/:id/summary',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const params = SessionParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid session id' });
      const session = deps.store.getSession(params.data.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      const deck = deps.decks.get(session.deck_id);
      if (!deck) return reply.code(404).send({ error: 'deck not found' });

      const facts = buildCallNotes(session.id, deck, deps.store.getEvents(session.id));
      let narrative = session.summary; // cached: one LLM call per session
      if (!narrative) {
        try {
          narrative = await deps.openai.complete(summaryPrompt(deck, facts));
          deps.store.saveSummary(session.id, narrative);
        } catch (err) {
          req.log.warn({ err }, 'summary generation failed');
          narrative = null;
        }
      }
      const notes: CallNotes = { ...facts, narrative };
      return notes;
    },
  );

  app.addHook('onClose', async () => hangupTimers.forEach(clearTimeout));
  return app;
}
