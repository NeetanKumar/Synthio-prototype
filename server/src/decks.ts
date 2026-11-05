import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeckSchema, type Deck } from '@msl/shared';

const DIR = join(import.meta.dirname, 'decks');

// Load and validate every deck at boot: a malformed deck crashes startup
// instead of failing mid-call.
export function loadDecks(dir = DIR): Map<string, Deck> {
  const decks = new Map<string, Deck>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const parsed = DeckSchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (!parsed.success) throw new Error(`Invalid deck ${file}: ${parsed.error.message}`);
    decks.set(parsed.data.id, parsed.data);
  }
  return decks;
}
