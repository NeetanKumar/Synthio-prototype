import { join } from 'node:path';
import { buildApp } from './app.ts';
import { loadDecks } from './decks.ts';
import { createMintSecret } from './openai.ts';

// Node 22 has a built-in .env loader; no dotenv dependency.
try {
  process.loadEnvFile(join(import.meta.dirname, '../../.env'));
} catch {
  /* no .env file: rely on real environment variables (e.g. on Fly) */
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const app = await buildApp({
  decks: loadDecks(),
  mintSecret: createMintSecret(apiKey),
  model: process.env.REALTIME_MODEL ?? 'gpt-realtime-2.1',
  voice: process.env.REALTIME_VOICE ?? 'marin',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  maxSessionMs: Number(process.env.MAX_SESSION_MS ?? 8 * 60_000),
});

await app.listen({ port: Number(process.env.PORT ?? 8787), host: '0.0.0.0' });
