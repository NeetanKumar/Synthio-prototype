import type { CallNotes, PublicDeck, RealtimeSessionResponse, TelemetryEvent } from '@msl/shared';
import { connectRealtime, type RealtimeConnection } from '../realtime/connection.ts';
import { parseServerEvent } from '../realtime/events.ts';
import { initialState, reduce, type Command, type Input, type MachineState } from './machine.ts';

// The only impure layer: owns the connection, the <audio> element, timers and
// telemetry. It feeds inputs into the reducer and executes the commands it returns.

export type Phase = 'ready' | 'starting' | 'live' | 'reconnecting' | 'failed' | 'ended';

export interface Snapshot {
  machine: MachineState;
  phase: Phase;
  micDenied: boolean;
  error: string | null;
  /** performance.now() deadline for the session cost guard. */
  deadline: number | null;
  model: string | null;
  notes: CallNotes | null;
  notesLoading: boolean;
}

const RECONNECT_DELAYS = [500, 1500, 4000];

/** A connect that finished after the user ended the call (or a newer attempt superseded it). */
class Superseded extends Error {}

export class AgentController {
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private conn: RealtimeConnection | null = null;
  private mic: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private sessionId: string | null = null;
  private t0 = 0;
  private textSeq = 0;
  private outbox: TelemetryEvent[] = [];
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every (re)connect so callbacks from a dead connection are ignored. */
  private generation = 0;

  constructor(
    deck: PublicDeck,
    private readonly audioEl: HTMLAudioElement,
    private readonly opts: { deckId: string; vad: 'server' | 'semantic' },
  ) {
    this.snap = {
      machine: initialState(deck.slides),
      phase: 'ready',
      micDenied: false,
      error: null,
      deadline: null,
      model: null,
      notes: null,
      notesLoading: false,
    };
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

  /** Read through a method so TS doesn't keep a stale narrowing across awaits. */
  private phase(): Phase {
    return this.snap.phase;
  }

  private now() {
    return performance.now() - this.t0;
  }

  private dispatch(input: Input) {
    const { state, commands } = reduce(this.snap.machine, input, this.now());
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
      case 'telemetry':
        this.outbox.push({ ...c.event, at: Math.round(this.now()) } as TelemetryEvent);
        break;
      case 'log':
        console.warn('[agent]', c.message);
        break;
      case 'end_call':
        // Let the last audio frames drain, then close and show call notes.
        setTimeout(() => void this.end(), 400);
        break;
    }
  }

  /** 0..1 microphone level for the meter (read on animation frames, not via React state). */
  getMicLevel = (): number => {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  };

  // --- lifecycle ---
  async start() {
    if (['starting', 'live', 'reconnecting'].includes(this.snap.phase)) return;
    this.t0 = performance.now();
    this.generation += 1;
    const gen = this.generation;
    // A new call is a new session: fresh log, fresh budget, no cached summary from the last one.
    this.sessionId = null;
    this.outbox = [];
    this.audioEl.muted = false; // a Stop in the previous call may have left it muted
    this.patch({
      phase: 'starting',
      error: null,
      notes: null,
      machine: initialState(this.snap.machine.slides),
    });

    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      this.audioCtx.createMediaStreamSource(this.mic).connect(this.analyser);
      this.patch({ micDenied: false });
    } catch {
      this.mic = null;
      this.patch({ micDenied: true }); // the text box drives the same session
    }

    try {
      const session = await this.openSession(gen);
      this.sessionId = session.sessionId;
      this.patch({ phase: 'live', model: session.model, deadline: performance.now() + session.maxSessionMs });
      this.endTimer = setTimeout(() => this.end('Session time limit reached. Showing call notes.'), session.maxSessionMs);
      this.flushTimer = setInterval(() => void this.flush(), 3000);
      this.outbox.push({ type: 'session', phase: 'start', at: 0 });
      this.dispatch({ type: 'connected' });
    } catch (err) {
      if (err instanceof Superseded) return; // ended while connecting: end() already cleaned up
      this.releaseMedia();
      this.patch({ phase: 'failed', error: err instanceof Error ? err.message : 'Could not connect.' });
    }
  }

  /** Mint a key and open the WebRTC call. Reused by reconnect. */
  private async openSession(gen: number): Promise<RealtimeSessionResponse> {
    const res = await fetch('/api/realtime/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId: this.opts.deckId, vad: this.opts.vad, sessionId: this.sessionId ?? undefined }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(res.status === 429 ? 'Too many sessions from this network. Try again later.' : `Could not start the briefing: ${body.error ?? res.status}.`);
    }
    const session = (await res.json()) as RealtimeSessionResponse;
    if (gen !== this.generation) throw new Superseded();

    const conn = await connectRealtime({
      clientSecret: session.clientSecret,
      mic: this.mic,
      audioEl: this.audioEl,
      onEvent: (raw) => {
        if (gen !== this.generation) return;
        const event = parseServerEvent(raw);
        if (event) this.dispatch({ type: 'server', event });
      },
      onConnectionState: (s) => {
        if (gen !== this.generation || this.snap.phase !== 'live') return;
        if (s === 'failed') this.handleDrop();
        // 'disconnected' can heal by itself (ICE restart); give it 2s first.
        else if (s === 'disconnected') this.dropTimer ??= setTimeout(() => this.handleDrop(), 2000);
        else if (s === 'connected' && this.dropTimer) {
          clearTimeout(this.dropTimer);
          this.dropTimer = null;
        }
      },
    });
    if (gen !== this.generation) {
      // The user ended the call while we were connecting: don't let this one go live.
      conn.close();
      throw new Superseded();
    }
    this.conn = conn;
    // Lets the server enforce the session limit by hanging up the call itself.
    if (this.conn.callId) {
      void fetch(`/api/sessions/${session.sessionId}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: this.conn.callId }),
      }).catch(() => {});
    }
    return session;
  }

  private async handleDrop() {
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = null;
    if (this.snap.phase !== 'live') return;
    this.generation += 1;
    this.conn?.close();
    this.conn = null;
    this.dispatch({ type: 'disconnected' });
    this.patch({ phase: 'reconnecting' });
    const gen = this.generation;

    for (const delay of RECONNECT_DELAYS) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.phase() !== 'reconnecting') return; // user ended meanwhile
      try {
        await this.openSession(gen);
        this.patch({ phase: 'live', error: null });
        this.dispatch({ type: 'reconnected' });
        return;
      } catch (err) {
        if (err instanceof Superseded) return; // ended during the attempt
        /* try again */
      }
    }
    this.patch({ phase: 'failed', error: 'Connection lost and could not be restored.' });
    void this.finish();
  }

  async end(reason?: string) {
    if (!['live', 'reconnecting', 'starting'].includes(this.snap.phase)) return;
    this.generation += 1;
    this.conn?.close();
    this.conn = null;
    this.dispatch({ type: 'ended' });
    this.patch({ phase: 'ended', error: reason ?? null, deadline: null });
    await this.finish();
  }

  /** Flush telemetry, release media, fetch call notes. */
  private async finish() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.flushTimer = this.endTimer = null;
    this.releaseMedia();
    await this.flush();
    if (!this.sessionId) return;
    this.patch({ notesLoading: true });
    try {
      const res = await fetch(`/api/sessions/${this.sessionId}/summary`, { method: 'POST' });
      if (res.ok) this.patch({ notes: (await res.json()) as CallNotes });
    } catch {
      /* call notes are best-effort; the UI falls back to local state */
    } finally {
      this.patch({ notesLoading: false });
    }
  }

  private releaseMedia() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.analyser = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  /** Send queued telemetry in batches. Returns once the outbox is empty or the server is unreachable. */
  private async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.sessionId && this.outbox.length > 0) {
        const events = this.outbox.splice(0, 200);
        let res: Response;
        try {
          res = await fetch(`/api/sessions/${this.sessionId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events }),
            keepalive: true, // survives tab close
          });
        } catch {
          this.outbox.unshift(...events); // offline: retry on the next flush
          return;
        }
        if (res.ok) continue;
        if (res.status >= 500 || res.status === 429) {
          this.outbox.unshift(...events); // transient: retry later
          return;
        }
        // 4xx (invalid batch, per-session cap): retrying can't succeed, so drop it and say so.
        console.warn(`[agent] telemetry batch dropped (${res.status}): ${events.length} events`);
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Tear down without call notes (component unmount). */
  dispose() {
    this.generation += 1;
    this.conn?.close();
    this.releaseMedia();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
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
    if (t && this.snap.phase === 'live') this.dispatch({ type: 'user_text', text: t, id: `text-${++this.textSeq}` });
  };
}
