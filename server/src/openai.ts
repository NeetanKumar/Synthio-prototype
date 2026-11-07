// Thin wrappers over the three OpenAI endpoints the server uses. Plain fetch, no
// SDK: three calls, and the request shapes stay visible.

const API = 'https://api.openai.com/v1';

export interface MintedSecret {
  value: string;
  expires_at: number;
}

export interface OpenAIClient {
  /** POST /v1/realtime/client_secrets */
  mintSecret: (session: object) => Promise<MintedSecret>;
  /** POST /v1/realtime/calls/{call_id}/hangup: server-side session limit. */
  hangup: (callId: string) => Promise<void>;
  /** POST /v1/responses: short text completion (call-notes summary). */
  complete: (prompt: string) => Promise<string>;
}

export function createOpenAI(apiKey: string, textModel: string): OpenAIClient {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  return {
    async mintSecret(session) {
      const res = await fetch(`${API}/realtime/client_secrets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // The secret only has to live long enough for the browser to open the call.
          expires_after: { anchor: 'created_at', seconds: 60 },
          session,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // Log upstream detail server-side; never forward it (it may echo config).
      if (!res.ok) throw new Error(`client_secrets ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as Partial<MintedSecret>;
      if (typeof body.value !== 'string' || typeof body.expires_at !== 'number') {
        throw new Error('client_secrets: unexpected response shape');
      }
      return { value: body.value, expires_at: body.expires_at };
    },

    async hangup(callId) {
      const res = await fetch(`${API}/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      // 404 = call already ended, which is fine.
      if (!res.ok && res.status !== 404) throw new Error(`hangup ${res.status}: ${await res.text()}`);
    },

    async complete(prompt) {
      const res = await fetch(`${API}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: textModel, input: prompt, max_output_tokens: 400 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`responses ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
      // output_text is an SDK convenience; over raw HTTP we read the message items.
      const text = (body.output ?? [])
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text' && c.text)
        .map((c) => c.text)
        .join('')
        .trim();
      if (!text) throw new Error('responses: empty output');
      return text;
    },
  };
}
