import { toolDefinitions, type Deck } from '@msl/shared';
import { buildInstructions } from './prompt.ts';

export type VadMode = 'server' | 'semantic';

export interface SessionOptions {
  model: string;
  voice: string;
  vad: VadMode;
}

// Shape of `session` in POST /v1/realtime/client_secrets
// (verified against openai@7.51.0 RealtimeSessionCreateRequest).
export function buildSessionConfig(deck: Deck, opts: SessionOptions) {
  const turnDetection =
    opts.vad === 'semantic'
      ? { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true }
      : {
          type: 'server_vad',
          // 0.6 (default 0.5) to reduce self-interruption from speaker echo.
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 450,
          create_response: true,
          // The server cancels the in-flight response the moment speech starts.
          interrupt_response: true,
        };

  return {
    type: 'realtime',
    model: opts.model,
    instructions: buildInstructions(deck),
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe' },
        noise_reduction: { type: 'far_field' },
        turn_detection: turnDetection,
      },
      output: { voice: opts.voice },
    },
    tools: toolDefinitions(),
    tool_choice: 'auto',
    // gpt-realtime-2.x are reasoning models; minimal effort keeps time-to-first-audio low.
    ...(opts.model.startsWith('gpt-realtime-2') ? { reasoning: { effort: 'minimal' } } : {}),
  } as const;
}
