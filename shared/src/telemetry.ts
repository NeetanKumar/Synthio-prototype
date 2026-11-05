import { z } from 'zod';
import { FlagType } from './tools.ts';

// Telemetry events the browser sends to POST /api/sessions/:id/events.
// `at` is ms since the call started.

const base = { at: z.number().nonnegative() };

export const TelemetryEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('session'), phase: z.enum(['start', 'end', 'reconnect']) }),
  z.object({ ...base, type: z.literal('question'), text: z.string().max(2000), slideId: z.string(), via: z.enum(['voice', 'text']) }),
  z.object({ ...base, type: z.literal('slide_change'), from: z.string(), to: z.string(), by: z.enum(['agent', 'user', 'auto']) }),
  z.object({ ...base, type: z.literal('interruption'), via: z.enum(['voice', 'manual']), slideId: z.string() }),
  z.object({ ...base, type: z.literal('latency'), metric: z.enum(['ttfa', 'interrupt_to_silence']), ms: z.number().nonnegative() }),
  z.object({ ...base, type: z.literal('tool_call'), name: z.string().max(64), ok: z.boolean() }),
  z.object({ ...base, type: z.literal('flag'), flag: FlagType, summary: z.string().max(1000), slideId: z.string() }),
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
/** What the reducer emits; the controller stamps `at`. */
export type TelemetryPayload = TelemetryEvent extends infer E ? (E extends { at: number } ? Omit<E, 'at'> : never) : never;

export const EventBatchSchema = z.object({ events: z.array(TelemetryEventSchema).min(1).max(200) });

export interface CallNotes {
  sessionId: string;
  deckId: string;
  durationMs: number;
  questions: Array<{ text: string; slideId: string; slideTitle: string; via: 'voice' | 'text' }>;
  flags: Array<{ flag: z.infer<typeof FlagType>; summary: string; slideId: string }>;
  slidesVisited: string[];
  interruptions: number;
  latency: { ttfaP50: number | null; interruptP50: number | null };
  /** LLM-written prose; null if the text model call failed. Facts above come from logs only. */
  narrative: string | null;
}
