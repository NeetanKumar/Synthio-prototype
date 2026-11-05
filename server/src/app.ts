import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { toPublicDeck, type Deck, type RealtimeSessionResponse } from '@msl/shared';
import { buildSessionConfig } from './sessionConfig.ts';
import type { MintSecret } from './openai.ts';

export interface AppDeps {
  decks: Map<string, Deck>;
  mintSecret: MintSecret;
  model: string;
  voice: string;
  webOrigin: string;
  maxSessionMs: number;
}

const SessionBody = z.object({
  deckId: z.string(),
  vad: z.enum(['server', 'semantic']).default('server'),
});

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: deps.webOrigin.split(',') });

  app.get('/api/health', async () => ({ ok: true }));

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => {
    const deck = deps.decks.get(req.params.id);
    if (!deck) return reply.code(404).send({ error: 'deck not found' });
    return toPublicDeck(deck);
  });

  app.post('/api/realtime/session', async (req, reply) => {
    const body = SessionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    const deck = deps.decks.get(body.data.deckId);
    if (!deck) return reply.code(404).send({ error: 'deck not found' });

    const session = buildSessionConfig(deck, { model: deps.model, voice: deps.voice, vad: body.data.vad });
    try {
      const secret = await deps.mintSecret(session);
      const res: RealtimeSessionResponse = {
        sessionId: randomUUID(),
        clientSecret: secret.value,
        expiresAt: secret.expires_at,
        model: deps.model,
        maxSessionMs: deps.maxSessionMs,
      };
      return res;
    } catch (err) {
      req.log.error({ err }, 'mint secret failed');
      return reply.code(502).send({ error: 'could not start a voice session' });
    }
  });

  return app;
}
