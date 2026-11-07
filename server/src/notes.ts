import { z } from 'zod';
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

/**
 * One text-model call does two jobs: pick which logged utterances were real
 * questions (greetings, "next slide", "ok", "stop" are not), and write the CRM
 * summary. The model only *selects* from logged utterances; it can't add facts.
 */
export function summaryPrompt(deck: Deck, notes: Omit<CallNotes, 'narrative'>): string {
  const utterances = notes.questions.map((q, i) => `${i}. "${q.text}" (answer shown on: ${q.slideTitle})`).join('\n');
  return [
    `You are writing CRM call notes after a medical science liaison voice briefing on "${deck.title}".`,
    '',
    'Task 1. Below are the physician\'s utterances that the agent answered. Return the indices of the ones that are substantive questions or information requests about the product or disease.',
    'Exclude greetings, acknowledgements ("ok", "good to go"), navigation or pacing commands ("next slide", "go back", "give me the summary"), stop/end requests, and unintelligible fragments.',
    '',
    'Task 2. Write a 2-3 sentence summary in neutral past tense, third person ("The physician asked..."). Use ONLY the facts below: no product claims, no numbers that are not listed.',
    'The summary describes the conversation only. Never mention utterances, indices, Task 1 or which items were excluded. If there were no substantive questions, just say what was covered.',
    notes.flags.some((f) => f.flag === 'adverse_event')
      ? 'An adverse event was flagged: say it was routed to pharmacovigilance.'
      : 'No adverse event was flagged: do not mention pharmacovigilance or adverse event reporting.',
    '',
    `Slides covered: ${notes.slidesVisited.map((id) => deck.slides.find((s) => s.id === id)?.title ?? id).join('; ')}`,
    `Utterances:\n${utterances || '(none)'}`,
    `Flags: ${notes.flags.length ? notes.flags.map((f) => `${f.flag}: ${f.summary}`).join('; ') : 'none'}`,
    '',
    'Respond with JSON only, no code fences: {"questions": [indices], "summary": "..."}',
  ].join('\n');
}

const SummaryJson = z.object({ questions: z.array(z.number().int().nonnegative()), summary: z.string().min(1) });

/** Apply the model's output; on any parse problem keep every utterance and drop the prose. */
export function applySummary(notes: Omit<CallNotes, 'narrative'>, raw: string): CallNotes {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: z.infer<typeof SummaryJson> | null = null;
  try {
    const r = SummaryJson.safeParse(JSON.parse(cleaned));
    if (r.success) parsed = r.data;
  } catch {
    parsed = null;
  }
  if (!parsed) return { ...notes, narrative: null };
  const keep = new Set(parsed.questions);
  return { ...notes, questions: notes.questions.filter((_, i) => keep.has(i)), narrative: parsed.summary.trim() };
}
