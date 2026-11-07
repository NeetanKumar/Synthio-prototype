export * from './deck.ts';
export * from './tools.ts';
export * from './telemetry.ts';
export * from './stats.ts';

/** Marks app-generated "director" messages (slide cues) in the conversation. */
export const CUE_PREFIX = '[cue]';

/** Response from POST /api/realtime/session. */
export interface RealtimeSessionResponse {
  sessionId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  maxSessionMs: number;
}
