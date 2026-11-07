import { z } from 'zod';

// Parse only the server events the agent reacts to. Everything else is ignored.
// Field names verified against openai@7.51.0 realtime types.

const ResponseObj = z.object({
  id: z.string(),
  status: z.string().optional(),
  status_details: z.object({ reason: z.string().optional() }).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  // Used on response.done to tell whether the response produced any audio.
  output: z
    .array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string() })).optional() }))
    .optional(),
});

const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created') }),
  z.object({ type: z.literal('input_audio_buffer.speech_started'), item_id: z.string() }),
  z.object({ type: z.literal('input_audio_buffer.speech_stopped'), item_id: z.string() }),
  z.object({ type: z.literal('conversation.item.input_audio_transcription.delta'), item_id: z.string(), delta: z.string().optional() }),
  z.object({ type: z.literal('conversation.item.input_audio_transcription.completed'), item_id: z.string(), transcript: z.string() }),
  z.object({ type: z.literal('response.created'), response: ResponseObj }),
  z.object({ type: z.literal('response.done'), response: ResponseObj }),
  z.object({ type: z.literal('response.output_audio_transcript.delta'), response_id: z.string(), item_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal('response.function_call_arguments.done'), response_id: z.string(), call_id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('output_audio_buffer.started'), response_id: z.string() }),
  z.object({ type: z.literal('output_audio_buffer.stopped'), response_id: z.string() }),
  z.object({ type: z.literal('output_audio_buffer.cleared'), response_id: z.string() }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string(), code: z.string().nullish(), type: z.string() }) }),
]);

export type ServerEvent = z.infer<typeof ServerEvent>;

const KNOWN: ReadonlySet<string> = new Set(ServerEvent.options.map((o) => o.shape.type.value));

/** Returns null for events we don't handle (or that are malformed). */
export function parseServerEvent(raw: string): ServerEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const type = (json as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN.has(type)) return null;
  const parsed = ServerEvent.safeParse(json);
  if (!parsed.success) {
    console.warn('[realtime] malformed event', type, parsed.error.issues);
    return null;
  }
  return parsed.data;
}

// Client events we send. Kept as a narrow union so a typo is a compile error.
export type ClientEvent =
  | { type: 'response.create'; response?: { metadata?: Record<string, string>; tool_choice?: 'auto' | 'none' } }
  | { type: 'response.cancel' }
  | { type: 'output_audio_buffer.clear' }
  | {
      type: 'conversation.item.create';
      item:
        | { type: 'message'; role: 'system' | 'user'; content: Array<{ type: 'input_text'; text: string }> }
        | { type: 'function_call_output'; call_id: string; output: string };
    };
