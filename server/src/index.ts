import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { Store } from './db.ts';
import { loadDecks } from './decks.ts';
import { createOpenAI } from './openai.ts';

// Node 22 has a built-in .env loader; no dotenv dependency.
try {
  process.loadEnvFile(join(import.meta.dirname, '../../.env'));
} catch {
  /* no .env file: rely on real environment variables (e.g. Fly secrets) */
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const env = process.env;
const app = await buildApp({
  decks: loadDecks(),
  openai: createOpenAI(apiKey, env.SUMMARY_MODEL ?? 'gpt-5.4-mini'),
  store: new Store(env.DB_PATH ?? join(import.meta.dirname, '../data/msl.db')),
  model: env.REALTIME_MODEL ?? 'gpt-realtime-2.1',
  voice: env.REALTIME_VOICE ?? 'marin',
  webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
  maxSessionMs: Number(env.MAX_SESSION_MS ?? 8 * 60_000),
  sessionsPerHour: Number(env.SESSIONS_PER_HOUR ?? 10),
  ipSalt: env.IP_SALT ?? randomBytes(16).toString('hex'),
});

await app.listen({ port: Number(env.PORT ?? 8787), host: '0.0.0.0' });
