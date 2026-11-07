import { CUE_PREFIX, type PublicSlide, type TelemetryPayload } from '@msl/shared';
import type { ClientEvent, ServerEvent } from '../realtime/events.ts';
import { calibrate, DEFAULT_CHARS_PER_MS, heardChars, lastHeardSentence } from './cursor.ts';
import { handleToolCall } from './toolHandler.ts';

// The whole conversation orchestration as a pure reducer:
//   reduce(state, input, now) -> { state, commands }
// Inputs are server events, UI actions and connection changes. Commands are
// side effects (send an event, mute audio, log telemetry) executed by the
// controller. Nothing here touches WebRTC or the DOM, so every interruption,
// tool and race edge case is a plain unit test.

export type AgentState = 'connecting' | 'reconnecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'ended' | 'error';
/** presenting: auto-advances. answering: Q&A, waits for the user. paused: user hit Stop. */
export type Mode = 'presenting' | 'answering' | 'paused';
type Kind = 'present' | 'answer';
type Cue = 'start' | 'next' | 'navigated' | 'resume';

export type Request =
  | { kind: 'present'; slideId: string; cue: Cue; recap?: string }
  | { kind: 'answer'; slideId: string }
  /** Follow-up after tool outputs: no cue, same kind as the response that called the tool. */
  | { kind: 'continue'; as: Kind; slideId: string };

/** Placeholder id between sending response.create and receiving response.created. */
export const PENDING = 'pending';

interface ActiveResponse {
  id: string;
  kind: Kind;
  slideId: string;
  /** What to do after response.done because of tool calls in this response. */
  after: 'continue' | 'resume' | null;
}

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'live' | 'done' | 'interrupted';
  responseId?: string;
  /** For interrupted assistant turns: estimated characters actually heard. */
  heardChars?: number;
}

export interface Flag {
  id: string;
  type: 'adverse_event' | 'off_label' | 'out_of_scope';
  summary: string;
  slideId: string;
}

export interface Question {
  id: string;
  text: string;
  /** Slide on screen when the answer finished; null until then. */
  slideId: string | null;
  via: 'voice' | 'text';
  reported: boolean;
}

/** Where the scripted narration stands on the current slide. */
interface Narration {
  slideId: string;
  /** All narration text for this slide so far, across responses. */
  text: string;
  /** Characters of `text` that belong to earlier, fully played responses. */
  baseChars: number;
  responseId: string | null;
}

export interface Metrics {
  ttfaMs: number[];
  interruptMs: number[];
  toolCalls: number;
  interruptions: number;
  responses: number;
}

export interface MachineState {
  slides: PublicSlide[];
  agent: AgentState;
  mode: Mode;
  slideId: string;
  /** goto_slide received while previous audio is still audible: show it when audio ends. */
  pendingSlideId: string | null;
  highlightId: string | null;
  /** Pointer that goes with pendingSlideId. */
  pendingHighlightId: string | null;
  /** end_call was requested: close the call once the goodbye has played. */
  ending: boolean;
  /** Slide the agent navigated to since the user last spoke. A resume then continues from it. */
  turnGoto: string | null;
  /** In-flight generation (at most one). */
  response: ActiveResponse | null;
  /** A response we want once the current one ends. Latest wins. */
  queued: Request | null;
  lastRequest: Request | null;
  /** Our last response.create, until a response carrying our metadata confirms it. */
  unconfirmed: Request | null;
  /** User hit Stop before response.created arrived: cancel it on arrival. */
  cancelOnCreate: boolean;
  /** Response whose audio is playing, or null when silent. */
  audioResponseId: string | null;
  audioStartAt: Record<string, number>;
  /** Local barge-in mute: silence is instant, no network round trip. */
  muted: boolean;
  /** Last present response that completed; when its audio ends we auto-advance. */
  lastPresent: { responseId: string; slideId: string } | null;
  narration: Narration | null;
  /** Where "shall I pick up where we left off?" returns to. */
  resume: { slideId: string; lastSentence: string | null } | null;
  charsPerMs: number;
  turns: Turn[];
  flags: Flag[];
  questions: Question[];
  visited: string[];
  /** Timers for latency metrics. */
  waitStartAt: number | null;
  interruptAt: number | null;
  metrics: Metrics;
}

export type Input =
  | { type: 'connected' }
  | { type: 'reconnected' }
  | { type: 'server'; event: ServerEvent }
  | { type: 'user_stop' }
  | { type: 'user_resume' }
  | { type: 'user_navigate'; slideId: string }
  | { type: 'user_text'; text: string; id: string }
  | { type: 'disconnected' }
  | { type: 'ended' };

export type Command =
  | { type: 'send'; event: ClientEvent }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'telemetry'; event: TelemetryPayload }
  /** Close the call (after the goodbye finished playing). */
  | { type: 'end_call' }
  | { type: 'log'; message: string };

export function initialState(slides: PublicSlide[]): MachineState {
  return {
    slides,
    agent: 'connecting',
    mode: 'presenting',
    slideId: slides[0]!.id,
    pendingSlideId: null,
    highlightId: null,
    pendingHighlightId: null,
    ending: false,
    turnGoto: null,
    response: null,
    queued: null,
    lastRequest: null,
    unconfirmed: null,
    cancelOnCreate: false,
    audioResponseId: null,
    audioStartAt: {},
    muted: false,
    lastPresent: null,
    narration: null,
    resume: null,
    charsPerMs: DEFAULT_CHARS_PER_MS,
    turns: [],
    flags: [],
    questions: [],
    visited: [slides[0]!.id],
    waitStartAt: null,
    interruptAt: null,
    metrics: { ttfaMs: [], interruptMs: [], toolCalls: 0, interruptions: 0, responses: 0 },
  };
}

// Errors that are expected races (e.g. cancelling a response that just finished).
const BENIGN_ERRORS = new Set(['response_cancel_not_active']);

export function reduce(prev: MachineState, input: Input, now = 0): { state: MachineState; commands: Command[] } {
  const s: MachineState = { ...prev, metrics: { ...prev.metrics } };
  const cmds: Command[] = [];
  const send = (event: ClientEvent) => cmds.push({ type: 'send', event });
  const track = (event: TelemetryPayload) => cmds.push({ type: 'telemetry', event });

  const title = (id: string) => s.slides.find((x) => x.id === id)?.title ?? id;
  const isLast = (id: string) => s.slides.at(-1)?.id === id;

  const setTurns = (fn: (t: Turn) => Turn) => {
    s.turns = s.turns.map(fn);
  };

  const showSlide = (id: string, by: 'agent' | 'user' | 'auto') => {
    if (s.slideId !== id) {
      track({ type: 'slide_change', from: s.slideId, to: id, by });
      s.highlightId = null;
      if (!s.visited.includes(id)) s.visited = [...s.visited, id];
    }
    s.slideId = id;
    s.pendingSlideId = null;
  };

  /** Estimate what was heard of the playing response and freeze it into the turn + cursor. */
  const freezeHeard = () => {
    const rid = s.audioResponseId;
    const started = rid ? s.audioStartAt[rid] : undefined;
    if (!rid || started === undefined) {
      setTurns((t) => (t.role === 'assistant' && t.status === 'live' ? { ...t, status: 'interrupted', heardChars: 0 } : t));
      return;
    }
    const played = Math.max(0, now - started);
    setTurns((t) =>
      t.role === 'assistant' && t.status === 'live' ? { ...t, status: 'interrupted', heardChars: t.responseId === rid ? heardChars(t.text, played, s.charsPerMs) : 0 } : t,
    );
    const n = s.narration;
    if (n && n.responseId === rid) {
      const ownText = n.text.slice(n.baseChars);
      const heard = n.baseChars + heardChars(ownText, played, s.charsPerMs);
      // Drop the unheard tail so a resume continues from what was actually heard.
      s.narration = { ...n, text: n.text.slice(0, heard), baseChars: heard, responseId: null };
    }
  };

  const cursorFor = (slideId: string) => ({
    slideId,
    lastSentence: s.narration?.slideId === slideId ? lastHeardSentence(s.narration.text, s.narration.text.length) : null,
  });

  /** Actually send a response request. Caller guarantees nothing is in flight. */
  const emit = (req: Request) => {
    s.lastRequest = req;
    s.unconfirmed = req;
    const kind: Kind = req.kind === 'continue' ? req.as : req.kind;
    s.response = { id: PENDING, kind, slideId: req.slideId, after: null };
    if (s.agent !== 'listening') s.agent = 'thinking';

    if (req.kind === 'present') {
      s.mode = 'presenting';
      s.lastPresent = null;
      if (req.cue !== 'resume' || s.narration?.slideId !== req.slideId) {
        s.narration = { slideId: req.slideId, text: '', baseChars: 0, responseId: null };
      }
      const t = `slide ${req.slideId} ("${title(req.slideId)}")`;
      let text: string;
      if (req.cue === 'start') text = `${CUE_PREFIX} start: greet the physician in one sentence, then present ${t}.`;
      else if (req.cue === 'navigated') text = `${CUE_PREFIX} the user navigated to ${t}. Present it briefly.`;
      else if (req.cue === 'next') text = `${CUE_PREFIX} present ${t}.${isLast(req.slideId) ? ' Then invite questions.' : ''}`;
      else {
        const last = s.narration?.slideId === req.slideId ? lastHeardSentence(s.narration.text, s.narration.text.length) : null;
        text = last
          ? `${CUE_PREFIX} resume ${t}. The last sentence the user heard was: "${last}". Continue right after it; do not repeat it.`
          : `${CUE_PREFIX} resume ${t} from the beginning, briefly.`;
      }
      if (req.recap) text = `${CUE_PREFIX} the connection dropped and was restored. ${req.recap}\n${text}`;
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    }
    send({ type: 'response.create', response: { metadata: { kind, slide_id: req.slideId } } });
  };

  /** Send now, or queue behind the in-flight response. */
  const request = (req: Request) => {
    if (s.response) s.queued = req;
    else emit(req);
  };

  const flushQueued = () => {
    if (!s.queued) return false;
    const q = s.queued;
    s.queued = null;
    emit(q);
    return true;
  };

  /** Stop whatever is generating or playing (Stop, navigation, typed input). */
  const stopOutput = () => {
    freezeHeard();
    if (s.response || s.audioResponseId) {
      cmds.push({ type: 'mute' });
      s.muted = true;
    }
    if (s.response?.id === PENDING) s.cancelOnCreate = true;
    else if (s.response) send({ type: 'response.cancel' });
    // WebRTC keeps already-generated audio in a server-side buffer; clear it too.
    if (s.audioResponseId) send({ type: 'output_audio_buffer.clear' });
    s.queued = null;
    s.lastPresent = null;
  };

  /** Report questions once both the text and the answering slide are known. */
  const reportQuestions = () => {
    s.questions = s.questions.map((q) => {
      if (q.reported || !q.slideId || !q.text.trim()) return q;
      track({ type: 'question', text: q.text, slideId: q.slideId, via: q.via });
      return { ...q, reported: true };
    });
  };

  /** Apply a slide (and pointer) that waited for the previous audio to finish. */
  const flushPending = () => {
    if (s.pendingSlideId) showSlide(s.pendingSlideId, 'agent');
    if (s.pendingHighlightId) s.highlightId = s.pendingHighlightId;
    s.pendingHighlightId = null;
  };

  /** Called when audio ends: show a queued slide and maybe advance the script. */
  const onSilence = (responseId: string) => {
    flushPending();
    if (s.agent === 'speaking') s.agent = 'idle';
    if (s.ending && !s.response) {
      cmds.push({ type: 'end_call' }); // the goodbye has played
      return;
    }
    if (s.narration?.responseId === responseId) s.narration = { ...s.narration, baseChars: s.narration.text.length, responseId: null };
    if (s.mode === 'presenting' && !s.response && !s.queued && s.lastPresent?.responseId === responseId) {
      const idx = s.slides.findIndex((x) => x.id === s.lastPresent!.slideId);
      const next = s.slides[idx + 1];
      s.lastPresent = null;
      if (next) {
        showSlide(next.id, 'auto');
        emit({ kind: 'present', slideId: next.id, cue: 'next' });
      } else {
        s.mode = 'answering'; // deck finished: open Q&A
        s.resume = null;
      }
    }
  };

  const markInterrupted = (via: 'voice' | 'manual') => {
    s.metrics.interruptions += 1;
    // Only time it if audio is playing: the clock stops on output_audio_buffer.cleared.
    s.interruptAt = s.audioResponseId ? now : null;
    track({ type: 'interruption', via, slideId: s.slideId });
  };

  switch (input.type) {
    case 'connected':
      s.agent = 'idle';
      emit({ kind: 'present', slideId: s.slides[0]!.id, cue: 'start' });
      break;

    case 'disconnected':
      freezeHeard();
      s.agent = 'reconnecting';
      if (s.mode === 'presenting') s.resume = cursorFor(s.slideId);
      s.response = null;
      s.queued = null;
      s.audioResponseId = null;
      s.cancelOnCreate = false;
      break;

    case 'reconnected': {
      // The new session has no memory: re-seed it with a compact recap.
      track({ type: 'session', phase: 'reconnect' });
      s.agent = 'idle';
      // State and the audio element must agree: a Stop just before the drop left it muted.
      s.muted = false;
      cmds.push({ type: 'unmute' });
      const asked = s.questions.filter((q) => q.text).map((q) => `"${q.text}"`).slice(-4);
      const target = s.resume?.slideId ?? s.slideId;
      const recap = `Slides covered so far: ${s.visited.join(', ')}. ${asked.length ? `Questions asked so far: ${asked.join('; ')}.` : 'No questions yet.'}`;
      showSlide(target, 'auto');
      s.resume = null;
      emit({ kind: 'present', slideId: target, cue: 'resume', recap });
      break;
    }

    case 'ended':
      freezeHeard();
      s.agent = 'ended';
      s.response = null;
      s.queued = null;
      track({ type: 'session', phase: 'end' });
      break;

    case 'user_stop':
      if (!s.response && !s.audioResponseId) {
        s.mode = s.mode === 'presenting' ? 'paused' : s.mode;
        break;
      }
      if (s.mode === 'presenting') {
        stopOutput();
        s.resume = cursorFor(s.slideId);
      } else stopOutput();
      markInterrupted('manual');
      s.mode = 'paused';
      s.agent = 'interrupted';
      break;

    case 'user_resume': {
      // If a (cancelled) response is still finishing, request() queues this behind it.
      const target = s.resume?.slideId ?? s.slideId;
      showSlide(target, 'user');
      s.resume = null;
      request({ kind: 'present', slideId: target, cue: 'resume' });
      break;
    }

    case 'user_navigate': {
      if (!s.slides.some((x) => x.id === input.slideId)) break;
      stopOutput();
      showSlide(input.slideId, 'user');
      s.resume = null;
      // Queued if a response is still being cancelled; fires on its response.done.
      request({ kind: 'present', slideId: input.slideId, cue: 'navigated' });
      break;
    }

    case 'user_text': {
      const wasPresenting = s.mode === 'presenting';
      stopOutput();
      if (wasPresenting) s.resume = cursorFor(s.slideId);
      s.mode = 'answering';
      s.turnGoto = null;
      s.waitStartAt = now;
      s.turns = [...s.turns, { id: input.id, role: 'user', text: input.text, status: 'done' }];
      s.questions = [...s.questions, { id: input.id, text: input.text, slideId: null, via: 'text', reported: false }];
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] } });
      request({ kind: 'answer', slideId: s.slideId });
      break;
    }

    case 'server':
      handleServer(input.event);
      break;
  }

  function handleServer(ev: ServerEvent) {
    switch (ev.type) {
      case 'session.created':
        break;

      case 'input_audio_buffer.speech_started': {
        // Barge-in. The server cancels the response itself (interrupt_response);
        // we mute locally so silence doesn't wait for the round trip.
        const talking = s.response !== null || s.audioResponseId !== null;
        if (talking) {
          const wasPresenting = s.mode === 'presenting';
          freezeHeard();
          cmds.push({ type: 'mute' });
          s.muted = true;
          if (wasPresenting) s.resume = cursorFor(s.slideId);
          if (s.audioResponseId) {
            send({ type: 'output_audio_buffer.clear' });
            markInterrupted('voice');
          }
        } else if (s.mode === 'presenting') {
          s.resume = cursorFor(s.slideId);
        }
        if (s.mode === 'presenting') s.mode = 'answering';
        s.queued = null;
        s.lastPresent = null;
        s.turnGoto = null; // a new user turn: earlier navigation no longer pending
        s.agent = 'listening';
        if (!s.turns.some((t) => t.id === ev.item_id)) {
          s.turns = [...s.turns, { id: ev.item_id, role: 'user', text: '', status: 'live' }];
          s.questions = [...s.questions, { id: ev.item_id, text: '', slideId: null, via: 'voice', reported: false }];
        }
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        if (s.agent === 'listening') s.agent = 'thinking';
        s.waitStartAt = now;
        break;

      case 'conversation.item.input_audio_transcription.delta':
        setTurns((t) => (t.id === ev.item_id ? { ...t, text: t.text + (ev.delta ?? '') } : t));
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const text = ev.transcript.trim();
        setTurns((t) => (t.id === ev.item_id ? { ...t, text, status: 'done' } : t));
        s.questions = s.questions.map((q) => (q.id === ev.item_id ? { ...q, text } : q));
        reportQuestions();
        break;
      }

      case 'response.created': {
        const md = ev.response.metadata ?? {};
        const kind: Kind = md.kind === 'present' ? 'present' : 'answer';
        // Ours (metadata echoed back) or one the server VAD created from speech.
        if (md.kind) s.unconfirmed = null;
        s.response = { id: ev.response.id, kind, slideId: md.slide_id ?? s.slideId, after: null };
        s.metrics.responses += 1;
        if (kind === 'present' && s.narration?.slideId === s.response.slideId) {
          s.narration = { ...s.narration, baseChars: s.narration.text.length, responseId: ev.response.id };
        }
        if (s.cancelOnCreate) {
          s.cancelOnCreate = false;
          send({ type: 'response.cancel' });
        }
        break;
      }

      case 'response.output_audio_transcript.delta': {
        if (s.turns.some((t) => t.id === ev.item_id)) setTurns((t) => (t.id === ev.item_id ? { ...t, text: t.text + ev.delta } : t));
        else s.turns = [...s.turns, { id: ev.item_id, role: 'assistant', text: ev.delta, status: 'live', responseId: ev.response_id }];
        if (s.narration?.responseId === ev.response_id) s.narration = { ...s.narration, text: s.narration.text + ev.delta };
        break;
      }

      case 'response.function_call_arguments.done': {
        s.metrics.toolCalls += 1;
        const result = handleToolCall({ slides: s.slides, currentSlideId: s.pendingSlideId ?? s.slideId }, ev.name, ev.arguments);
        track({ type: 'tool_call', name: ev.name, ok: result.output.ok === true });
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result.output) } });
        const r = s.response && (s.response.id === ev.response_id || s.response.id === PENDING) ? s.response : null;
        const fx = result.effect;
        if (fx.type === 'goto') {
          s.turnGoto = fx.slideId;
          if (s.mode === 'presenting') {
            s.resume = s.resume ?? cursorFor(s.slideId);
            s.mode = 'answering';
          }
          // Don't flip the slide under the previous answer's still-playing audio.
          if (s.audioResponseId && !s.muted) {
            s.pendingSlideId = fx.slideId;
            s.pendingHighlightId = fx.elementId ?? null;
          } else {
            showSlide(fx.slideId, 'agent');
            if (fx.elementId) s.highlightId = fx.elementId;
          }
        } else if (fx.type === 'highlight') {
          // The element belongs to the pending slide if one is queued: show it with that slide.
          if (s.pendingSlideId) s.pendingHighlightId = fx.elementId;
          else s.highlightId = fx.elementId;
        } else if (fx.type === 'flag') {
          const slideId = s.pendingSlideId ?? s.slideId;
          s.flags = [...s.flags, { id: ev.call_id, type: fx.flag, summary: fx.summary, slideId }];
          track({ type: 'flag', flag: fx.flag, summary: fx.summary, slideId });
        } else if (fx.type === 'resume' || fx.type === 'end') {
          // "Yes, carry on", "next slide" and "let's stop" are not questions: drop them from the call notes.
          const lastQ = [...s.questions].reverse().find((q) => !q.reported);
          if (lastQ) s.questions = s.questions.filter((q) => q.id !== lastQ.id);
          if (fx.type === 'end') {
            s.ending = true;
            s.resume = null;
          }
        }
        // response.create must wait for response.done (one response at a time).
        if (r) {
          s.response = {
            ...r,
            after: fx.type === 'resume' ? 'resume' : (r.after ?? 'continue'),
          };
        }
        break;
      }

      case 'response.done': {
        const done = ev.response;
        const r = s.response && (s.response.id === done.id || s.response.id === PENDING) ? s.response : null;
        if (!r) {
          // Stale/unknown response finished; if we were waiting on it, go.
          if (!s.response) flushQueued();
          break;
        }
        s.response = null;
        const status = done.status ?? 'completed';
        setTurns((t) => (t.responseId === done.id && t.status === 'live' ? { ...t, status: status === 'completed' ? 'done' : 'interrupted' } : t));

        if (status !== 'completed') {
          // Cancelled (barge-in, Stop, navigation) or failed: drop tool follow-ups.
          if (!flushQueued() && s.agent === 'thinking') s.agent = 'idle';
          break;
        }
        if (r.kind === 'answer' && r.after !== 'continue') {
          // The answer is complete: attribute pending questions to the slide it landed on.
          const slideId = s.pendingSlideId ?? s.slideId;
          s.questions = s.questions.map((q) => (q.slideId === null ? { ...q, slideId } : q));
          reportQuestions();
        }
        if (flushQueued()) break;
        if (r.after === 'resume' && s.turnGoto) {
          // Voice navigation ("next slide", "go back"): goto then resume, in one turn or across
          // the follow-up turn, means "present from the new slide", not "go back to the cursor".
          const target = s.turnGoto;
          s.turnGoto = null;
          flushPending();
          showSlide(target, 'agent');
          s.resume = null;
          emit({ kind: 'present', slideId: target, cue: 'navigated' });
          break;
        }
        if (r.after === 'resume') {
          const target = s.resume?.slideId ?? s.slideId;
          showSlide(target, 'auto');
          s.resume = null;
          emit({ kind: 'present', slideId: target, cue: 'resume' });
          break;
        }
        if (r.after === 'continue') {
          // Tool outputs are in the conversation; let the model keep talking.
          emit({ kind: 'continue', as: r.kind, slideId: s.pendingSlideId ?? s.slideId });
          break;
        }
        const hadAudio = (done.output ?? []).some((i) => i.content?.some((c) => c.type === 'output_audio'));
        if (s.ending) {
          // Goodbye generated: close now if silent, else when its audio finishes (onSilence).
          if (!hadAudio && s.audioResponseId === null) cmds.push({ type: 'end_call' });
          break;
        }
        if (r.kind === 'present') {
          s.lastPresent = { responseId: done.id, slideId: r.slideId };
          // No audio will play, so no output_audio_buffer.stopped: advance now.
          if (!hadAudio && s.audioResponseId !== done.id) onSilence(done.id);
        } else if (!hadAudio && s.agent === 'thinking') {
          s.agent = 'idle';
        }
        break;
      }

      case 'output_audio_buffer.started':
        s.audioResponseId = ev.response_id;
        s.audioStartAt = { ...s.audioStartAt, [ev.response_id]: now };
        if (s.muted) {
          s.muted = false;
          cmds.push({ type: 'unmute' });
        }
        if (s.waitStartAt !== null) {
          const ms = Math.max(0, now - s.waitStartAt);
          s.metrics.ttfaMs = [...s.metrics.ttfaMs, ms];
          track({ type: 'latency', metric: 'ttfa', ms });
          s.waitStartAt = null;
        }
        s.agent = 'speaking';
        break;

      case 'output_audio_buffer.stopped': {
        const started = s.audioStartAt[ev.response_id];
        if (started !== undefined) {
          // Played to the end: calibrate the speaking rate for the narration cursor.
          const text = s.turns.filter((t) => t.responseId === ev.response_id && t.role === 'assistant').map((t) => t.text).join(' ');
          s.charsPerMs = calibrate(s.charsPerMs, text.length, now - started);
        }
        if (s.audioResponseId === ev.response_id) s.audioResponseId = null;
        onSilence(ev.response_id);
        break;
      }

      case 'output_audio_buffer.cleared':
        if (s.interruptAt !== null) {
          const ms = Math.max(0, now - s.interruptAt);
          s.metrics.interruptMs = [...s.metrics.interruptMs, ms];
          track({ type: 'latency', metric: 'interrupt_to_silence', ms });
          s.interruptAt = null;
        }
        if (s.audioResponseId === ev.response_id) s.audioResponseId = null;
        flushPending();
        if (s.agent === 'speaking') s.agent = 'interrupted';
        break;

      case 'error': {
        const code = ev.error.code ?? '';
        if (BENIGN_ERRORS.has(code)) break;
        if (code === 'conversation_already_has_active_response' && s.unconfirmed) {
          // Our response.create lost a race with a server (VAD) response. It may arrive before or
          // after that response's response.created, so key off `unconfirmed`, not PENDING.
          const lost = s.unconfirmed;
          s.unconfirmed = null;
          if (s.response?.id === PENDING) s.response = null;
          // Retry with response.create only: any cue item is already in the conversation.
          // Drop a scripted step if the user has since taken over (the VAD response is theirs).
          const stillWanted = lost.kind !== 'present' || s.mode === 'presenting';
          if (stillWanted && !s.queued) {
            const kind = lost.kind === 'continue' ? lost.as : lost.kind;
            s.queued = { kind: 'continue', as: kind, slideId: lost.slideId };
          }
        }
        cmds.push({ type: 'log', message: `${ev.error.type}${code ? `/${code}` : ''}: ${ev.error.message}` });
        break;
      }
    }
  }

  return { state: s, commands: cmds };
}
