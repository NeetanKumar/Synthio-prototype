export * from './deck.ts';
export * from './tools.ts';

/** Response from POST /api/realtime/session. */
export interface RealtimeSessionResponse {
  sessionId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  maxSessionMs: number;
}
