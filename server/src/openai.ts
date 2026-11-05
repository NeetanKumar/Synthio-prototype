// Thin wrapper over the one OpenAI endpoint the server needs in P0.
// Plain fetch, no SDK: one call, and it keeps the request shape visible.

export interface MintedSecret {
  value: string;
  expires_at: number;
}

export type MintSecret = (session: object) => Promise<MintedSecret>;

export function createMintSecret(apiKey: string): MintSecret {
  return async (session) => {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The secret only has to live long enough for the browser to open the call.
        expires_after: { anchor: 'created_at', seconds: 60 },
        session,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Log upstream detail server-side; never forward it (it may echo config).
      throw new Error(`client_secrets ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as Partial<MintedSecret>;
    if (typeof body.value !== 'string' || typeof body.expires_at !== 'number') {
      throw new Error('client_secrets: unexpected response shape');
    }
    return { value: body.value, expires_at: body.expires_at };
  };
}
