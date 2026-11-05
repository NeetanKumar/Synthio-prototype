import type { PublicDeck, RealtimeSessionResponse } from '@msl/shared';
import { connectRealtime, type RealtimeConnection } from '../realtime/connection.ts';
import { parseServerEvent } from '../realtime/events.ts';
import { initialState, reduce, type Command, type Input, type MachineState } from './machine.ts';

// The only impure layer: owns the connection and the <audio> element, feeds
// inputs into the reducer and executes the commands it returns.

export type Phase = 'ready' | 'starting' | 'live' | 'failed' | 'ended';

export interface Snapshot {
  machine: MachineState;
  phase: Phase;
  micDenied: boolean;
  error: string | null;
}

export class AgentController {
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private conn: RealtimeConnection | null = null;
  private textSeq = 0;

  constructor(
    deck: PublicDeck,
    private readonly audioEl: HTMLAudioElement,
    private readonly opts: { deckId: string; vad: 'server' | 'semantic' },
  ) {
    this.snap = { machine: initialState(deck.slides), phase: 'ready', micDenied: false, error: null };
  }

  // --- useSyncExternalStore plumbing ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private patch(p: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }

  private dispatch(input: Input) {
    const { state, commands } = reduce(this.snap.machine, input);
    commands.forEach((c) => this.exec(c));
    this.patch({ machine: state });
  }

  private exec(c: Command) {
    switch (c.type) {
      case 'send':
        this.conn?.send(c.event);
        break;
      case 'mute':
        this.audioEl.muted = true;
        break;
      case 'unmute':
        this.audioEl.muted = false;
        break;
      case 'log':
        console.warn('[agent]', c.message);
        break;
    }
  }

  // --- lifecycle ---
  async start() {
    if (this.snap.phase === 'starting' || this.snap.phase === 'live') return;
    this.patch({ phase: 'starting', error: null });

    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.patch({ micDenied: true }); // text input drives the same session
    }

    try {
      const res = await fetch('/api/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckId: this.opts.deckId, vad: this.opts.vad }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(res.status === 429 ? 'Too many sessions from this network. Try again later.' : `Could not start the briefing: ${body.error ?? res.status}.`);
      }
      const session = (await res.json()) as RealtimeSessionResponse;

      this.conn = await connectRealtime({
        clientSecret: session.clientSecret,
        mic,
        audioEl: this.audioEl,
        onEvent: (raw) => {
          const event = parseServerEvent(raw);
          if (event) this.dispatch({ type: 'server', event });
        },
        onConnectionState: (s) => {
          if ((s === 'failed' || s === 'disconnected') && this.snap.phase === 'live') {
            this.dispatch({ type: 'disconnected' });
            this.patch({ phase: 'failed', error: 'Connection lost.' });
          }
        },
      });
      this.patch({ phase: 'live' });
      this.dispatch({ type: 'connected' });
    } catch (err) {
      mic?.getTracks().forEach((t) => t.stop());
      this.patch({ phase: 'failed', error: err instanceof Error ? err.message : 'Could not connect.' });
    }
  }

  end() {
    this.conn?.close();
    this.conn = null;
    this.dispatch({ type: 'ended' });
    this.patch({ phase: 'ended' });
  }

  // --- user actions ---
  stop = () => this.dispatch({ type: 'user_stop' });
  resume = () => this.dispatch({ type: 'user_resume' });
  navigate = (slideId: string) => {
    if (this.snap.phase === 'live') this.dispatch({ type: 'user_navigate', slideId });
    else this.patch({ machine: { ...this.snap.machine, slideId, highlightId: null } }); // browse before starting
  };
  sendText = (text: string) => {
    const t = text.trim();
    if (t) this.dispatch({ type: 'user_text', text: t, id: `text-${++this.textSeq}` });
  };
}
