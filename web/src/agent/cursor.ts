// Narration cursor helpers (pure).
//
// Transcript text arrives ahead of the audio, so "what the user actually heard"
// is estimated from playback time x speaking rate. The rate is calibrated on
// every response that plays to the end (characters / audio duration).

export const DEFAULT_CHARS_PER_MS = 0.0145; // ~150 wpm

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Number of transcript characters heard after `playedMs` of audio. */
export function heardChars(text: string, playedMs: number, charsPerMs: number): number {
  return Math.max(0, Math.min(text.length, Math.round(playedMs * charsPerMs)));
}

/** Last complete sentence that was fully heard, or null if the first one was cut off. */
export function lastHeardSentence(text: string, heard: number): string | null {
  let end = 0;
  let last: string | null = null;
  for (const sentence of splitSentences(text)) {
    const idx = text.indexOf(sentence, end);
    end = idx + sentence.length;
    if (end > heard) break;
    // A fragment without terminal punctuation was cut off mid-sentence.
    if (/[.!?]["')\]]?$/.test(sentence)) last = sentence;
  }
  return last;
}

/** Exponential moving average so one odd response can't skew the rate. */
export function calibrate(rate: number, chars: number, durationMs: number): number {
  if (durationMs < 1500 || chars < 20) return rate;
  const observed = chars / durationMs;
  // Guard against nonsense (e.g. clock jumps): 5..40 chars/s.
  if (observed < 0.005 || observed > 0.04) return rate;
  return rate * 0.7 + observed * 0.3;
}

export { median } from '@msl/shared';
