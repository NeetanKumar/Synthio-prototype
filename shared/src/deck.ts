import { z } from 'zod';

// Stable, human-readable IDs. The model sees these, so they must be short and
// meaningful ("efficacy-easi75"), not UUIDs.
export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case id');

const Bullet = z.object({
  kind: z.literal('bullet'),
  id: IdSchema,
  text: z.string().min(1),
  detail: z.string().optional(),
});

const Stat = z.object({
  kind: z.literal('stat'),
  id: IdSchema,
  value: z.string(),
  label: z.string(),
});

// Grouped bar chart: one group per endpoint, two arms per group.
// Each group id is highlightable on its own ("laser pointer" on a bar pair).
const Chart = z.object({
  kind: z.literal('chart'),
  id: IdSchema,
  title: z.string(),
  unit: z.string(),
  arms: z.tuple([z.string(), z.string()]),
  groups: z
    .array(
      z.object({
        id: IdSchema,
        label: z.string(),
        values: z.tuple([z.number(), z.number()]),
      }),
    )
    .min(1),
  footnote: z.string().optional(),
});

const Table = z.object({
  kind: z.literal('table'),
  id: IdSchema,
  columns: z.array(z.string()).min(2),
  rows: z.array(z.object({ id: IdSchema, cells: z.array(z.string()) })).min(1),
  footnote: z.string().optional(),
});

// Linear pathway diagram (mechanism of action); each step is highlightable.
const Flow = z.object({
  kind: z.literal('flow'),
  id: IdSchema,
  steps: z
    .array(
      z.object({
        id: IdSchema,
        label: z.string(),
        caption: z.string(),
        blocked: z.boolean().optional(),
      }),
    )
    .min(2),
});

export const ElementSchema = z.discriminatedUnion('kind', [Bullet, Stat, Chart, Table, Flow]);

export const SlideSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  kicker: z.string().optional(),
  elements: z.array(ElementSchema).min(1),
  speakerNotes: z.string().min(1),
  knowledge: z.array(z.string()).default([]),
});

export const DeckSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    subtitle: z.string(),
    persona: z.string(), // who the agent is
    audience: z.string(), // who it is talking to
    footer: z.string(),
    slides: z.array(SlideSchema).min(2).max(10),
  })
  .superRefine((deck, ctx) => {
    // Element IDs must be unique across the whole deck, because highlight()
    // takes a bare element_id with no slide qualifier.
    const seen = new Set<string>();
    for (const slide of deck.slides) {
      for (const id of [slide.id, ...highlightableIds(slide)]) {
        if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate id "${id}"` });
        seen.add(id);
      }
    }
  });

export type Element = z.infer<typeof ElementSchema>;
export type Slide = z.infer<typeof SlideSchema>;
export type Deck = z.infer<typeof DeckSchema>;

/** Every ID on a slide that highlight() may target: elements plus their sub-parts. */
export function highlightableIds(slide: Pick<Slide, 'elements'>): string[] {
  return slide.elements.flatMap((el) => {
    switch (el.kind) {
      case 'chart':
        return [el.id, ...el.groups.map((g) => g.id)];
      case 'table':
        return [el.id, ...el.rows.map((r) => r.id)];
      case 'flow':
        return [el.id, ...el.steps.map((s) => s.id)];
      default:
        return [el.id];
    }
  });
}

/**
 * What the browser receives. speakerNotes and knowledge are prompt material,
 * so they stay on the server alongside the instructions.
 */
export type PublicSlide = Omit<Slide, 'speakerNotes' | 'knowledge'>;
export type PublicDeck = Omit<Deck, 'slides' | 'persona'> & { slides: PublicSlide[] };

export function toPublicDeck(deck: Deck): PublicDeck {
  const { persona: _persona, slides, ...rest } = deck;
  return {
    ...rest,
    slides: slides.map(({ speakerNotes: _n, knowledge: _k, ...s }) => s),
  };
}
