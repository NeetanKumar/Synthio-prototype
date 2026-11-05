import { describe, expect, it } from 'vitest';
import type { PublicSlide } from '@msl/shared';
import { handleToolCall } from './toolHandler.ts';

const slides: PublicSlide[] = [
  { id: 'intro', title: 'Intro', elements: [{ kind: 'bullet', id: 'intro-a', text: 'A' }] },
  {
    id: 'efficacy',
    title: 'Efficacy',
    elements: [{ kind: 'chart', id: 'chart', title: 'c', unit: '%', arms: ['x', 'y'], groups: [{ id: 'easi75', label: 'EASI-75', values: [50, 17] }] }],
  },
];
const ctx = { slides, currentSlideId: 'intro' };

describe('goto_slide', () => {
  it('navigates to a valid slide', () => {
    const r = handleToolCall(ctx, 'goto_slide', '{"slide_id":"efficacy","reason":"asked"}');
    expect(r.output).toEqual({ ok: true, slide_id: 'efficacy', title: 'Efficacy' });
    expect(r.effect).toEqual({ type: 'goto', slideId: 'efficacy' });
  });

  it('is idempotent for the current slide (duplicate goto)', () => {
    const r = handleToolCall(ctx, 'goto_slide', '{"slide_id":"intro","reason":"x"}');
    expect(r.output).toMatchObject({ ok: true, already_showing: true });
    expect(r.effect.type).toBe('none');
  });

  it('rejects an invalid id and lists valid ones', () => {
    const r = handleToolCall(ctx, 'goto_slide', '{"slide_id":"pricing","reason":"x"}');
    expect(r.output).toMatchObject({ ok: false, valid_slide_ids: ['intro', 'efficacy'] });
    expect(r.effect.type).toBe('none');
  });

  it('rejects malformed JSON and missing fields', () => {
    expect(handleToolCall(ctx, 'goto_slide', '{nope').output).toMatchObject({ ok: false });
    expect(handleToolCall(ctx, 'goto_slide', '{"slide_id":"efficacy"}').output).toMatchObject({ ok: false });
  });
});

describe('highlight', () => {
  it('accepts elements and sub-parts on the current slide', () => {
    const r = handleToolCall({ slides, currentSlideId: 'efficacy' }, 'highlight', '{"element_id":"easi75"}');
    expect(r.effect).toEqual({ type: 'highlight', elementId: 'easi75' });
  });

  it('tells the model to goto first when the element is on another slide', () => {
    const r = handleToolCall(ctx, 'highlight', '{"element_id":"easi75"}');
    expect(r.output.ok).toBe(false);
    expect(String(r.output.error)).toContain('call goto_slide first');
  });
});

describe('flag_for_followup and others', () => {
  it('validates the flag type', () => {
    expect(handleToolCall(ctx, 'flag_for_followup', '{"type":"adverse_event","summary":"rash"}').effect).toEqual({
      type: 'flag',
      flag: 'adverse_event',
      summary: 'rash',
    });
    expect(handleToolCall(ctx, 'flag_for_followup', '{"type":"gossip","summary":"x"}').output.ok).toBe(false);
  });

  it('resume accepts empty arguments', () => {
    expect(handleToolCall(ctx, 'resume_presentation', '').effect).toEqual({ type: 'resume' });
  });

  it('rejects unknown tools', () => {
    expect(handleToolCall(ctx, 'rm_rf', '{}').output.ok).toBe(false);
  });
});
