import { highlightableIds, type Deck, type Element, type Slide } from '@msl/shared';

// The system prompt is built from the deck, so swapping the JSON swaps the topic.
// It never leaves the server: it is baked into the ephemeral session config.

/** Marker the client uses for "director" messages (slide cues, navigation). */
export const CUE_PREFIX = '[cue]';

function describeElement(el: Element): string {
  switch (el.kind) {
    case 'bullet':
      return `- (${el.id}) ${el.text}`;
    case 'stat':
      return `- (${el.id}) stat: ${el.value} ${el.label}`;
    case 'chart': {
      const groups = el.groups
        .map((g) => `  - (${g.id}) ${g.label}: ${el.arms[0]} ${g.values[0]}${el.unit} vs ${el.arms[1]} ${g.values[1]}${el.unit}`)
        .join('\n');
      return `- (${el.id}) chart "${el.title}"\n${groups}${el.footnote ? `\n  note: ${el.footnote}` : ''}`;
    }
    case 'table': {
      const rows = el.rows.map((r) => `  - (${r.id}) ${r.cells.join(' | ')}`).join('\n');
      return `- (${el.id}) table [${el.columns.join(' | ')}]\n${rows}${el.footnote ? `\n  note: ${el.footnote}` : ''}`;
    }
    case 'flow': {
      const steps = el.steps
        .map((s) => `  - (${s.id}) ${s.label}: ${s.caption}${s.blocked ? ' [blocked by drug]' : ''}`)
        .join('\n');
      return `- (${el.id}) pathway diagram\n${steps}`;
    }
  }
}

export function describeSlide(slide: Slide, index: number): string {
  const knowledge = slide.knowledge.length
    ? slide.knowledge.map((k) => `- ${k}`).join('\n')
    : '- (none)';
  return [
    `## Slide ${index + 1} — id: ${slide.id} — "${slide.title}"`,
    `Visible on screen:`,
    ...slide.elements.map(describeElement),
    `Speaker notes (what to convey, in your own words): ${slide.speakerNotes}`,
    `Background knowledge (NOT on screen; use only to answer questions):`,
    knowledge,
  ].join('\n');
}

export function buildInstructions(deck: Deck): string {
  const slideIds = deck.slides.map((s) => s.id).join(', ');
  return `
# Role
You are ${deck.persona}. You are presenting "${deck.title}" (${deck.subtitle}) by voice to ${deck.audience}.
Everything in this deck is fictional and synthetic. If asked whether the product is real, say plainly that it is a fictional demo.

# Voice style
- Speak like a calm, credible colleague on a call. Warm, concise, no hype, no marketing superlatives.
- 2 to 4 short sentences per slide. Never read bullets verbatim; paraphrase.
- Say numbers naturally ("about half", "fifty-two percent"). Never spell out IDs.

# Presentation protocol
- Messages that start with "${CUE_PREFIX}" come from the presentation app, not from the user. Follow them silently: never mention cues, slide IDs or tools.
- A cue like "${CUE_PREFIX} present slide <id>" means the slide is already on screen: present it now. Do not call goto_slide for it.
- A cue saying the user navigated means they chose that slide; present it from the start, briefly.
- A cue saying "resume" means continue the current slide from where you were cut off. Do not restart it or repeat what was already said.

# Answering questions
1. If the answer lives on a different slide than the one on screen, call goto_slide FIRST, before saying anything about it.
2. Answer ONLY from the deck: visible content plus background knowledge below. 3 sentences or fewer.
3. Never invent numbers, studies, comparisons or doses. If the deck does not contain the answer, say so plainly ("I don't have data on that") and call flag_for_followup with type out_of_scope.
4. Questions about uses outside the label (other diseases, unstudied ages, unstudied combinations): say it is outside the label and that you cannot advise on it, then call flag_for_followup with type off_label.
5. If the user mentions a side effect or adverse event in a patient: acknowledge it with empathy, call flag_for_followup with type adverse_event, and mention that it should be reported to pharmacovigilance.
6. After answering, offer to continue, e.g. "Shall I pick up where we left off?"
7. If the user agrees to continue, or only acknowledges ("okay", "mm-hm", "go on"), call resume_presentation and say nothing else.

# Tools
- goto_slide(slide_id, reason): valid slide IDs are: ${slideIds}.
- highlight(element_id): point at an element on the current slide as you discuss it. Element IDs are in parentheses below.
- flag_for_followup(type, summary): compliance log, as described above.
- resume_presentation(): hand control back to the scripted presentation.

# Deck
${deck.slides.map(describeSlide).join('\n\n')}
`.trim();
}

/** Every valid target, used by tests and (later) the eval. */
export function deckIndex(deck: Deck): { slides: string[]; elements: Record<string, string> } {
  const elements: Record<string, string> = {};
  for (const s of deck.slides) for (const id of highlightableIds(s)) elements[id] = s.id;
  return { slides: deck.slides.map((s) => s.id), elements };
}
