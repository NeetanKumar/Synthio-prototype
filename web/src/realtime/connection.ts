import type { ClientEvent } from './events.ts';

// Browser <-> OpenAI over WebRTC. Audio flows on media tracks; JSON events on the
// "oai-events" data channel. Same handshake as OpenAI's own agents-realtime SDK:
// POST the SDP offer to /v1/realtime/calls with the ephemeral key.

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export interface ConnectOptions {
  clientSecret: string;
  /** null = mic denied: we still receive audio, the user types instead. */
  mic: MediaStream | null;
  audioEl: HTMLAudioElement;
  onEvent: (raw: string) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
}

export interface RealtimeConnection {
  send: (event: ClientEvent) => void;
  close: () => void;
  callId: string | undefined;
}

export async function connectRealtime(opts: ConnectOptions): Promise<RealtimeConnection> {
  const pc = new RTCPeerConnection();
  pc.onconnectionstatechange = () => opts.onConnectionState(pc.connectionState);

  pc.ontrack = (e) => {
    opts.audioEl.srcObject = e.streams[0] ?? null;
    void opts.audioEl.play().catch(() => {
      /* autoplay is allowed: connect() is always called from a click */
    });
  };

  const micTrack = opts.mic?.getAudioTracks()[0];
  if (micTrack && opts.mic) pc.addTrack(micTrack, opts.mic);
  else pc.addTransceiver('audio', { direction: 'recvonly' });

  const dc = pc.createDataChannel('oai-events');
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') opts.onEvent(e.data);
  };
  const open = new Promise<void>((resolve, reject) => {
    dc.onopen = () => resolve();
    dc.onerror = () => reject(new Error('data channel error'));
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(CALLS_URL, {
    method: 'POST',
    body: offer.sdp,
    headers: { Authorization: `Bearer ${opts.clientSecret}`, 'Content-Type': 'application/sdp' },
  });
  if (!res.ok) {
    pc.close();
    throw new Error(`WebRTC handshake failed (${res.status})`);
  }
  // Call id is the last path segment of Location; the server can hang up with it.
  const callId = res.headers.get('Location')?.split('/').pop();
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

  await Promise.race([
    open,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('data channel timeout')), 10_000)),
  ]);

  return {
    callId,
    send: (event) => {
      if (dc.readyState === 'open') dc.send(JSON.stringify(event));
    },
    close: () => {
      dc.close();
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
    },
  };
}
