import { CUE_PREFIX, type PublicSlide } from '@msl/shared';
import type { ClientEvent, ServerEvent } from '../realtime/events.ts';
import { handleToolCall } from './toolHandler.ts';

// The whole conversation orchestration as a pure reducer:
//   reduce(state, input) -> { state, commands }
// Inputs are server events, UI actions and connection changes. Commands are
// side effects (send an event, mute audio) executed by the controller. Because
// nothing here touches WebRTC or the DOM, every interruption/tool edge case
// is a plain unit test.

export type AgentState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'ended' | 'error';
/** presenting: auto-advances. answering: Q&A, waits for the user. paused: user hit Stop. */
export type Mode = 'presenting' | 'answering' | 'paused';
type Kind = 'present' | 'answer';
type Cue = 'start' | 'next' | 'navigated' | 'resume';

export type Request = { kind: 'present'; slideId: string; cue: Cue } | { kind: 'answer'; slideId: string };

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
}

export interface Flag {
  id: string;
  type: 'adverse_event' | 'off_label' | 'out_of_scope';
  summary: string;
  slideId: string;
}

export interface MachineState {
  slides: PublicSlide[];
  agent: AgentState;
  mode: Mode;
  /** Slide on screen. */
  slideId: string;
  /** goto_slide received while the previous answer is still audible: show it when audio ends. */
  pendingSlideId: string | null;
  highlightId: string | null;
  /** In-flight generation (at most one). */
  response: ActiveResponse | null;
  /** A response we want once the current one ends. Latest wins. */
  queued: Request | null;
  lastRequest: Request | null;
  /** User hit Stop before response.created arrived: cancel it on arrival. */
  cancelOnCreate: boolean;
  /** Response whose audio is playing in the browser, or null when silent. */
  audioResponseId: string | null;
  /** Local barge-in mute: silence is instant, no network round trip. */
  muted: boolean;
  /** Last present response that completed; when its audio ends we auto-advance. */
  lastPresent: { responseId: string; slideId: string } | null;
  /** Slide to return to on "shall I pick up where we left off?". */
  resumeSlideId: string | null;
  turns: Turn[];
  flags: Flag[];
  toolCalls: number;
}

export type Input =
  | { type: 'connected' }
  | { type: 'server'; event: ServerEvent }
  | { type: 'user_stop' }
  | { type: 'user_resume' }
  | { type: 'user_navigate'; slideId: string }
  | { type: 'user_text'; text: string; id: string }
  | { type: 'disconnected' }
  | { type: 'ended' };

export type Command = { type: 'send'; event: ClientEvent } | { type: 'mute' } | { type: 'unmute' } | { type: 'log'; message: string };

export function initialState(slides: PublicSlide[]): MachineState {
  return {
    slides,
    agent: 'connecting',
    mode: 'presenting',
    slideId: slides[0]!.id,
    pendingSlideId: null,
    highlightId: null,
    response: null,
    queued: null,
    lastRequest: null,
    cancelOnCreate: false,
    audioResponseId: null,
    muted: false,
    lastPresent: null,
    resumeSlideId: null,
    turns: [],
    flags: [],
    toolCalls: 0,
  };
}

// Errors that are expected races (e.g. cancelling a response that just finished).
const BENIGN_ERRORS = new Set(['response_cancel_not_active']);

export function reduce(prev: MachineState, input: Input): { state: MachineState; commands: Command[] } {
  const s: MachineState = { ...prev };
  const cmds: Command[] = [];
  const send = (event: ClientEvent) => cmds.push({ type: 'send', event });

  const title = (id: string) => s.slides.find((x) => x.id === id)?.title ?? id;
  const isLast = (id: string) => s.slides.at(-1)?.id === id;

  const setTurns = (fn: (t: Turn) => Turn) => {
    s.turns = s.turns.map(fn);
  };
  const markLiveAssistant = (status: Turn['status']) =>
    setTurns((t) => (t.role === 'assistant' && t.status === 'live' ? { ...t, status } : t));

  const showSlide = (id: string) => {
    if (s.slideId !== id) s.highlightId = null;
    s.slideId = id;
    s.pendingSlideId = null;
  };

  /** Actually send a response request. Caller guarantees nothing is in flight. */
  const emit = (req: Request) => {
    s.lastRequest = req;
    s.response = { id: PENDING, kind: req.kind, slideId: req.slideId, after: null };
    s.agent = s.agent === 'listening' ? 'listening' : 'thinking';
    if (req.kind === 'present') {
      s.mode = 'presenting';
      s.lastPresent = null;
      const t = title(req.slideId);
      const text =
        req.cue === 'start'
          ? `${CUE_PREFIX} start: greet the physician in one sentence, then present slide ${req.slideId} ("${t}").`
          : req.cue === 'navigated'
            ? `${CUE_PREFIX} the user navigated to slide ${req.slideId} ("${t}"). Present it briefly.`
            : req.cue === 'resume'
              ? `${CUE_PREFIX} resume slide ${req.slideId} ("${t}") from where you were cut off. Do not repeat what was already said.`
              : `${CUE_PREFIX} present slide ${req.slideId} ("${t}").${isLast(req.slideId) ? ' Then invite questions.' : ''}`;
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
      // Scripted narration doesn't call tools in P0; routing happens in answers.
      send({ type: 'response.create', response: { metadata: { kind: 'present', slide_id: req.slideId }, tool_choice: 'none' } });
    } else {
      send({ type: 'response.create', response: { metadata: { kind: 'answer', slide_id: req.slideId } } });
    }
  };

  /** Send now, or queue behind the in-flight response. */
  const request = (req: Request) => {
    if (s.response) s.queued = req;
    else emit(req);
  };

  /** Stop whatever is generating or playing. Used by Stop, navigation and typed input. */
  const stopOutput = () => {
    if (s.response || s.audioResponseId) {
      cmds.push({ type: 'mute' });
      s.muted = true;
    }
    if (s.response?.id === PENDING) s.cancelOnCreate = true;
    else if (s.response) send({ type: 'response.cancel' });
    // WebRTC keeps already-generated audio in a server-side buffer; clear it too.
    if (s.audioResponseId) send({ type: 'output_audio_buffer.clear' });
    s.queued = null;
    markLiveAssistant('interrupted');
  };

  /** Called when audio ends: show a queued slide and maybe advance the script. */
  const onSilence = (responseId: string) => {
    if (s.pendingSlideId) showSlide(s.pendingSlideId);
    if (s.agent === 'speaking') s.agent = 'idle';
    if (s.mode === 'presenting' && !s.response && !s.queued && s.lastPresent?.responseId === responseId) {
      const idx = s.slides.findIndex((x) => x.id === s.lastPresent!.slideId);
      const next = s.slides[idx + 1];
      s.lastPresent = null;
      if (next) {
        showSlide(next.id);
        emit({ kind: 'present', slideId: next.id, cue: 'next' });
      } else {
        s.mode = 'answering'; // deck finished: open Q&A
        s.resumeSlideId = null;
      }
    }
  };

  switch (input.type) {
    case 'connected':
      s.agent = 'idle';
      emit({ kind: 'present', slideId: s.slides[0]!.id, cue: 'start' });
      break;

    case 'disconnected':
      s.agent = 'error';
      s.response = null;
      s.audioResponseId = null;
      break;

    case 'ended':
      s.agent = 'ended';
      break;

    case 'user_stop':
      if (s.mode === 'presenting') s.resumeSlideId = s.slideId;
      stopOutput();
      s.mode = 'paused';
      s.agent = 'interrupted';
      break;

    case 'user_resume':
      if (s.response) break;
      showSlide(s.resumeSlideId ?? s.slideId);
      request({ kind: 'present', slideId: s.slideId, cue: 'resume' });
      s.resumeSlideId = null;
      break;

    case 'user_navigate': {
      if (!s.slides.some((x) => x.id === input.slideId)) break;
      stopOutput();
      showSlide(input.slideId);
      s.resumeSlideId = null;
      // Queued if a response is still being cancelled; fires on its response.done.
      request({ kind: 'present', slideId: input.slideId, cue: 'navigated' });
      break;
    }

    case 'user_text': {
      if (s.mode === 'presenting') s.resumeSlideId = s.slideId;
      stopOutput();
      s.mode = 'answering';
      s.turns = [...s.turns, { id: input.id, role: 'user', text: input.text, status: 'done' }];
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
        if (s.response || s.audioResponseId) {
          cmds.push({ type: 'mute' });
          s.muted = true;
          markLiveAssistant('interrupted');
        }
        if (s.audioResponseId) send({ type: 'output_audio_buffer.clear' });
        if (s.mode === 'presenting') {
          s.resumeSlideId = s.slideId;
          s.mode = 'answering';
        }
        s.queued = null;
        s.lastPresent = null;
        s.agent = 'listening';
        if (!s.turns.some((t) => t.id === ev.item_id)) {
          s.turns = [...s.turns, { id: ev.item_id, role: 'user', text: '', status: 'live' }];
        }
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        if (s.agent === 'listening') s.agent = 'thinking';
        break;

      case 'conversation.item.input_audio_transcription.delta':
        setTurns((t) => (t.id === ev.item_id ? { ...t, text: t.text + (ev.delta ?? '') } : t));
        break;

      case 'conversation.item.input_audio_transcription.completed':
        setTurns((t) => (t.id === ev.item_id ? { ...t, text: ev.transcript.trim(), status: 'done' } : t));
        break;

      case 'response.created': {
        const md = ev.response.metadata ?? {};
        const kind: Kind = md.kind === 'present' ? 'present' : 'answer';
        // Ours (metadata echoed back) or one the server VAD created from speech.
        s.response = { id: ev.response.id, kind, slideId: md.slide_id ?? s.slideId, after: null };
        if (s.cancelOnCreate) {
          s.cancelOnCreate = false;
          send({ type: 'response.cancel' });
        }
        break;
      }

      case 'response.output_audio_transcript.delta': {
        const existing = s.turns.find((t) => t.id === ev.item_id);
        if (existing) setTurns((t) => (t.id === ev.item_id ? { ...t, text: t.text + ev.delta } : t));
        else s.turns = [...s.turns, { id: ev.item_id, role: 'assistant', text: ev.delta, status: 'live', responseId: ev.response_id }];
        break;
      }

      case 'response.function_call_arguments.done': {
        s.toolCalls += 1;
        const result = handleToolCall({ slides: s.slides, currentSlideId: s.pendingSlideId ?? s.slideId }, ev.name, ev.arguments);
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result.output) } });
        const r = s.response && (s.response.id === ev.response_id || s.response.id === PENDING) ? s.response : null;
        const fx = result.effect;
        if (fx.type === 'goto') {
          // Don't flip the slide under the previous answer's still-playing audio.
          if (s.audioResponseId && !s.muted) s.pendingSlideId = fx.slideId;
          else showSlide(fx.slideId);
          if (s.mode === 'presenting') {
            s.resumeSlideId = s.resumeSlideId ?? s.slideId;
            s.mode = 'answering';
          }
        } else if (fx.type === 'highlight') {
          s.highlightId = fx.elementId;
        } else if (fx.type === 'flag') {
          s.flags = [...s.flags, { id: ev.call_id, type: fx.flag, summary: fx.summary, slideId: s.pendingSlideId ?? s.slideId }];
        }
        if (r) r.after = fx.type === 'resume' ? 'resume' : (r.after ?? 'continue');
        // response.create must wait for response.done (one response at a time).
        if (r) s.response = { ...r };
        break;
      }

      case 'response.done': {
        const done = ev.response;
        const r = s.response && (s.response.id === done.id || s.response.id === PENDING) ? s.response : null;
        if (!r) {
          // Stale/unknown response finished; if we were waiting on it, go.
          if (!s.response && s.queued) {
            const q = s.queued;
            s.queued = null;
            emit(q);
          }
          break;
        }
        s.response = null;
        const status = done.status ?? 'completed';
        setTurns((t) => (t.responseId === done.id && t.status === 'live' ? { ...t, status: status === 'completed' ? 'done' : 'interrupted' } : t));

        if (status !== 'completed') {
          // Cancelled (barge-in, Stop, navigation) or failed: drop tool follow-ups.
          if (s.queued) {
            const q = s.queued;
            s.queued = null;
            emit(q);
          } else if (s.agent === 'thinking') s.agent = 'idle';
          break;
        }
        if (s.queued) {
          const q = s.queued;
          s.queued = null;
          emit(q);
          break;
        }
        if (r.after === 'resume') {
          const target = s.resumeSlideId ?? s.slideId;
          s.resumeSlideId = null;
          showSlide(target);
          emit({ kind: 'present', slideId: target, cue: 'resume' });
          break;
        }
        if (r.after === 'continue') {
          // Tool outputs are in the conversation; let the model keep talking.
          emit(r.kind === 'present' ? { kind: 'present', slideId: r.slideId, cue: 'resume' } : { kind: 'answer', slideId: s.pendingSlideId ?? s.slideId });
          break;
        }
        const hadAudio = (done.output ?? []).some((i) => i.content?.some((c) => c.type === 'output_audio'));
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
        if (s.muted) {
          s.muted = false;
          cmds.push({ type: 'unmute' });
        }
        s.agent = 'speaking';
        break;

      case 'output_audio_buffer.stopped':
        if (s.audioResponseId === ev.response_id) s.audioResponseId = null;
        onSilence(ev.response_id);
        break;

      case 'output_audio_buffer.cleared':
        if (s.audioResponseId === ev.response_id) s.audioResponseId = null;
        if (s.pendingSlideId) showSlide(s.pendingSlideId);
        if (s.agent === 'speaking') s.agent = 'interrupted';
        break;

      case 'error': {
        const code = ev.error.code ?? '';
        if (BENIGN_ERRORS.has(code)) break;
        if (s.response?.id === PENDING && code === 'conversation_already_has_active_response') {
          // Our create lost a race with a VAD response; retry when it finishes.
          s.response = null;
          s.queued = s.lastRequest;
        }
        cmds.push({ type: 'log', message: `${ev.error.type}${code ? `/${code}` : ''}: ${ev.error.message}` });
        break;
      }
    }
  }

  return { state: s, commands: cmds };
}
