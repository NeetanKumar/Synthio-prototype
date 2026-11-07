import { describe, expect, it } from 'vitest';
import { applySummary, summaryPrompt } from './notes.ts';
import { loadDecks } from './decks.ts';
import type { CallNotes } from '@msl/shared';

const deck = loadDecks().get('lumirexa')!;
const base: Omit<CallNotes, 'narrative'> = {
  sessionId: 's', deckId: 'lumirexa', durationMs: 1, interruptions: 0, slidesVisited: ['unmet-need'],
  latency: { ttfaP50: null, interruptP50: null }, flags: [],
  questions: [
    { text: 'Hi, excuse me', slideId: 'unmet-need', slideTitle: 't', via: 'voice' },
    { text: 'What was EASI-75?', slideId: 'efficacy', slideTitle: 't', via: 'voice' },
  ],
};

describe('call-notes summary', () => {
  it('keeps only the questions the model selects', () => {
    const n = applySummary(base, '```json\n{"questions":[1],"summary":"The physician asked about efficacy."}\n```');
    expect(n.questions.map((q) => q.text)).toEqual(['What was EASI-75?']);
    expect(n.narrative).toBe('The physician asked about efficacy.');
  });
  it('falls back to every utterance and no prose when the output is not valid JSON', () => {
    const n = applySummary(base, 'Sure! Here is a summary.');
    expect(n.questions).toHaveLength(2);
    expect(n.narrative).toBeNull();
  });
  it('only mentions pharmacovigilance when an adverse event was flagged', () => {
    expect(summaryPrompt(deck, base)).toContain('do not mention pharmacovigilance');
    expect(summaryPrompt(deck, { ...base, flags: [{ flag: 'adverse_event', summary: 'rash', slideId: 'safety' }] })).toContain('routed to pharmacovigilance');
  });
});
