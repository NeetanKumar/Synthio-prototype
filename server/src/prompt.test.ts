import { describe, expect, it } from 'vitest';
import { DeckSchema, toolDefinitions, toPublicDeck } from '@msl/shared';
import { loadDecks } from './decks.ts';
import { buildInstructions, CUE_PREFIX, deckIndex } from './prompt.ts';
import { buildSessionConfig } from './sessionConfig.ts';

const deck = loadDecks().get('lumirexa')!;

describe('buildInstructions', () => {
  const prompt = buildInstructions(deck);

  it('lists every slide id and every highlightable element id', () => {
    const { slides, elements } = deckIndex(deck);
    for (const id of slides) expect(prompt).toContain(`id: ${id}`);
    for (const id of Object.keys(elements)) expect(prompt).toContain(`(${id})`);
  });

  it('includes hidden knowledge so questions can be answered', () => {
    expect(prompt).toContain('LUMEN-LTE');
    expect(prompt).toContain('Herpes zoster');
  });

  it('carries the non-negotiable rules', () => {
    expect(prompt).toMatch(/call goto_slide FIRST/);
    expect(prompt).toMatch(/Make all tool calls before you speak/);
    expect(prompt).toMatch(/Never invent numbers/);
    expect(prompt).toMatch(/adverse_event/);
    expect(prompt).toMatch(/off_label/);
    expect(prompt).toContain(CUE_PREFIX);
  });

  it('is deterministic (cache-friendly, testable)', () => {
    expect(buildInstructions(deck)).toBe(prompt);
  });

  it('follows the deck: a different deck yields different content', () => {
    const other = DeckSchema.parse({
      ...deck,
      id: 'other',
      title: 'Other Deck',
      slides: deck.slides.slice(0, 2).map((s) => ({ ...s, id: `x-${s.id}`, elements: s.elements.slice(0, 1).map((e) => ({ ...e, id: `x-${e.id}` })) })),
    });
    const p = buildInstructions(other);
    expect(p).toContain('Other Deck');
    expect(p).not.toContain('id: efficacy');
  });
});

describe('deck schema', () => {
  it('rejects duplicate element ids across slides', () => {
    const dup = structuredClone(deck);
    dup.slides[1]!.elements[0] = { kind: 'bullet', id: 'need-itch', text: 'dup' };
    expect(DeckSchema.safeParse(dup).success).toBe(false);
  });

  it('public deck strips speaker notes and knowledge', () => {
    const json = JSON.stringify(toPublicDeck(deck));
    expect(json).not.toContain('speakerNotes');
    expect(json).not.toContain('knowledge');
    expect(json).not.toContain('LUMEN-LTE');
  });
});

describe('session config', () => {
  it('enables interrupting VAD and registers all tools', () => {
    const s = buildSessionConfig(deck, { model: 'gpt-realtime-2.1', voice: 'marin', vad: 'server' });
    expect(s.audio.input.turn_detection).toMatchObject({ type: 'server_vad', interrupt_response: true, create_response: true });
    expect(s.tools.map((t) => t.name)).toEqual(['goto_slide', 'highlight', 'flag_for_followup', 'resume_presentation']);
    expect(s).toHaveProperty('reasoning.effort', 'minimal');
  });

  it('tool parameter schemas are plain JSON schema objects', () => {
    for (const t of toolDefinitions()) {
      expect(t.parameters).toMatchObject({ type: 'object' });
      expect(t.parameters).not.toHaveProperty('$schema');
    }
  });
});
