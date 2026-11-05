import type { CallNotes, Deck, TelemetryEvent } from '@msl/shared';

function p50(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * Deterministic call notes from the event log. Every fact here is traceable to
 * a logged event; the LLM only writes the prose summary on top (regulated domain:
 * the record must not depend on a model's recall).
 */
export function buildCallNotes(sessionId: string, deck: Deck, events: TelemetryEvent[]): Omit<CallNotes, 'narrative'> {
  const title = (id: string) => deck.slides.find((s) => s.id === id)?.title ?? id;
  const visited: string[] = [deck.slides[0]!.id];
  const ttfa: number[] = [];
  const interrupt: number[] = [];
  const questions: CallNotes['questions'] = [];
  const flags: CallNotes['flags'] = [];
  let interruptions = 0;

  for (const e of events) {
    switch (e.type) {
      case 'slide_change':
        if (!visited.includes(e.to)) visited.push(e.to);
        break;
      case 'question':
        questions.push({ text: e.text, slideId: e.slideId, slideTitle: title(e.slideId), via: e.via });
        break;
      case 'flag':
        flags.push({ flag: e.flag, summary: e.summary, slideId: e.slideId });
        break;
      case 'interruption':
        interruptions += 1;
        break;
      case 'latency':
        (e.metric === 'ttfa' ? ttfa : interrupt).push(e.ms);
        break;
      default:
        break;
    }
  }

  return {
    sessionId,
    deckId: deck.id,
    durationMs: events.length ? Math.max(...events.map((e) => e.at)) : 0,
    questions,
    flags,
    slidesVisited: visited,
    interruptions,
    latency: { ttfaP50: p50(ttfa), interruptP50: p50(interrupt) },
  };
}

/** Prompt for the prose summary. Facts only from the notes; no product claims added. */
export function summaryPrompt(deck: Deck, notes: Omit<CallNotes, 'narrative'>): string {
  return [
    `Write a 2-3 sentence call summary for a CRM note after a medical science liaison briefing on "${deck.title}".`,
    'Use ONLY the facts below. Do not add product claims or numbers. Neutral, past tense, third person ("The physician asked...").',
    'If adverse events were flagged, say that they were routed to pharmacovigilance.',
    '',
    `Slides covered: ${notes.slidesVisited.map((id) => deck.slides.find((s) => s.id === id)?.title ?? id).join('; ')}`,
    `Questions: ${notes.questions.length ? notes.questions.map((q) => `"${q.text}" (answered on: ${q.slideTitle})`).join('; ') : 'none'}`,
    `Flags: ${notes.flags.length ? notes.flags.map((f) => `${f.flag}: ${f.summary}`).join('; ') : 'none'}`,
  ].join('\n');
}
