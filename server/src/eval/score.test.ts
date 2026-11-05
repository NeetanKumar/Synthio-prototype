import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDecks } from '../decks.ts';
import { scoreCase, summarize, type EvalCase } from './score.ts';

describe('eval scoring', () => {
  it('routes to the last goto, or stays on the start slide', () => {
    const c: EvalCase = { q: 'x', slide: 'safety' };
    expect(scoreCase(c, 'unmet-need', [{ name: 'goto_slide', args: { slide_id: 'safety' } }], 'a', false).routingOk).toBe(true);
    expect(scoreCase(c, 'unmet-need', [], 'a', false).routedSlide).toBe('unmet-need');
  });

  it('scores flags and ignores routing when no slide is expected', () => {
    const c: EvalCase = { q: 'price?', slide: null, flag: 'out_of_scope' };
    const r = scoreCase(c, 's', [{ name: 'flag_for_followup', args: { type: 'out_of_scope', summary: 'x' } }], '', false);
    expect(r).toMatchObject({ routingOk: null, flagOk: true });
  });

  it('detects speaking before navigating', () => {
    const r = scoreCase({ q: 'x', slide: 'b' }, 'a', [{ name: 'goto_slide', args: { slide_id: 'b' } }], 'text', true);
    expect(r.gotoBeforeSpeech).toBe(false);
  });

  it('summarizes accuracy and spurious flags', () => {
    const results = [
      scoreCase({ q: '1', slide: 'b' }, 'a', [{ name: 'goto_slide', args: { slide_id: 'b' } }], '', false),
      scoreCase({ q: '2', slide: 'c' }, 'a', [{ name: 'flag_for_followup', args: { type: 'off_label' } }], '', false),
    ];
    expect(summarize(results)).toMatchObject({ routingAccuracy: 50, routingN: 2, spuriousFlags: 1 });
  });

  it('every expected slide in questions.json exists in the deck', () => {
    const spec = JSON.parse(readFileSync(join(import.meta.dirname, 'questions.json'), 'utf8')) as { deck: string; cases: EvalCase[] };
    const ids = loadDecks().get(spec.deck)!.slides.map((s) => s.id);
    for (const c of spec.cases) if (c.slide) expect(ids).toContain(c.slide);
    expect(spec.cases.length).toBeGreaterThanOrEqual(20);
  });
});
