import { describe, expect, it } from 'vitest';
import type { PublicSlide } from '@msl/shared';
import type { ServerEvent } from '../realtime/events.ts';
import { initialState, PENDING, reduce, type Command, type Input, type MachineState } from './machine.ts';

const slides: PublicSlide[] = ['s1', 's2', 's3'].map((id) => ({
  id,
  title: id.toUpperCase(),
  elements: [{ kind: 'bullet', id: `${id}-a`, text: 'x' }],
}));

/** Feed inputs in order; return final state and every command emitted. */
function run(inputs: Input[], start: MachineState = initialState(slides)) {
  let state = start;
  const commands: Command[] = [];
  for (const i of inputs) {
    const r = reduce(state, i);
    state = r.state;
    commands.push(...r.commands);
  }
  return { state, commands };
}

const srv = (event: ServerEvent): Input => ({ type: 'server', event });
const created = (id: string, kind?: string, slide?: string) =>
  srv({ type: 'response.created', response: { id, metadata: kind ? { kind, slide_id: slide ?? 's1' } : null } });
const done = (id: string, status = 'completed', audio = true) =>
  srv({ type: 'response.done', response: { id, status, output: audio ? [{ type: 'message', content: [{ type: 'output_audio' }] }] : [] } });
const started = (id: string) => srv({ type: 'output_audio_buffer.started', response_id: id });
const stopped = (id: string) => srv({ type: 'output_audio_buffer.stopped', response_id: id });
const speech = (item = 'u1') => srv({ type: 'input_audio_buffer.speech_started', item_id: item });
const tool = (resp: string, name: string, args: object) =>
  srv({ type: 'response.function_call_arguments.done', response_id: resp, call_id: `c-${name}`, name, arguments: JSON.stringify(args) });
const sent = (cmds: Command[]) => cmds.flatMap((c) => (c.type === 'send' ? [c.event.type] : []));
const responseCreates = (cmds: Command[]) =>
  cmds.flatMap((c) => (c.type === 'send' && c.event.type === 'response.create' ? [c.event.response?.metadata] : []));

/** Connected, slide 1 presented and currently speaking. */
const speakingS1 = () => run([{ type: 'connected' }, created('r1', 'present', 's1'), started('r1')]);

describe('autonomous presentation', () => {
  it('starts on slide 1 with a cue then response.create', () => {
    const { state, commands } = run([{ type: 'connected' }]);
    expect(sent(commands)).toEqual(['conversation.item.create', 'response.create']);
    expect(state.response?.id).toBe(PENDING);
    expect(state.agent).toBe('thinking');
  });

  it('advances only after the audio finishes playing, not when generation ends', () => {
    const a = run([done('r1'), started('r1')], speakingS1().state);
    expect(a.state.slideId).toBe('s1');
    expect(responseCreates(a.commands)).toEqual([]);
    const b = run([stopped('r1')], a.state);
    expect(b.state.slideId).toBe('s2');
    expect(responseCreates(b.commands)).toEqual([{ kind: 'present', slide_id: 's2' }]);
  });

  it('opens Q&A after the last slide', () => {
    let st = speakingS1().state;
    for (const [r, s] of [['r1', 's1'], ['r2', 's2'], ['r3', 's3']] as const) {
      st = run([created(r, 'present', s), started(r), done(r), stopped(r)], st).state;
    }
    expect(st.slideId).toBe('s3');
    expect(st.mode).toBe('answering');
    expect(st.response).toBeNull();
  });
});

describe('interruption', () => {
  it('voice barge-in: mutes instantly, marks the turn interrupted, stops auto-advance', () => {
    const base = run([srv({ type: 'response.output_audio_transcript.delta', response_id: 'r1', item_id: 'a1', delta: 'Hello' })], speakingS1().state);
    const { state, commands } = run([speech()], base.state);
    expect(commands[0]).toEqual({ type: 'mute' });
    expect(sent(commands)).toContain('output_audio_buffer.clear');
    expect(state.agent).toBe('listening');
    expect(state.mode).toBe('answering');
    expect(state.resumeSlideId).toBe('s1');
    expect(state.turns.find((t) => t.id === 'a1')?.status).toBe('interrupted');
    // Late audio-stopped for the cancelled response must NOT advance the deck.
    const after = run([done('r1', 'cancelled'), stopped('r1')], state);
    expect(after.state.slideId).toBe('s1');
    expect(responseCreates(after.commands)).toEqual([]);
  });

  it('unmutes when the next response starts speaking', () => {
    const st = run([speech(), done('r1', 'cancelled'), created('r2')], speakingS1().state).state;
    const { state, commands } = run([started('r2')], st);
    expect(commands).toContainEqual({ type: 'unmute' });
    expect(state.agent).toBe('speaking');
  });

  it('manual stop: cancel + clear, paused', () => {
    const { state, commands } = run([{ type: 'user_stop' }], speakingS1().state);
    expect(sent(commands)).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    expect(state.mode).toBe('paused');
    expect(state.agent).toBe('interrupted');
  });

  it('stop before response.created arrives cancels it on arrival', () => {
    const st = run([{ type: 'connected' }, { type: 'user_stop' }]).state;
    expect(st.cancelOnCreate).toBe(true);
    const { commands } = run([created('r1', 'present')], st);
    expect(sent(commands)).toEqual(['response.cancel']);
  });
});

describe('question → slide change', () => {
  it('goto then continuation after response.done; no auto-advance afterwards', () => {
    const st = run([speech(), done('r1', 'cancelled'), created('r2')], speakingS1().state).state;
    const a = run([tool('r2', 'goto_slide', { slide_id: 's3', reason: 'q' })], st);
    expect(a.state.slideId).toBe('s3'); // nothing audible: flips immediately
    expect(sent(a.commands)).toEqual(['conversation.item.create']); // tool output only
    const b = run([done('r2', 'completed', false)], a.state);
    expect(responseCreates(b.commands)).toEqual([{ kind: 'answer', slide_id: 's3' }]);
    const c = run([created('r3'), started('r3'), done('r3'), stopped('r3')], b.state);
    expect(c.state.slideId).toBe('s3');
    expect(responseCreates(c.commands)).toEqual([]); // answering mode waits for the user
  });

  it('goto while previous audio is audible is deferred until silence', () => {
    // An answer response still playing, then a second response's tool call arrives.
    const st = run([created('r1'), started('r1'), done('r1'), created('r2')], run([{ type: 'connected' }]).state).state;
    const a = run([tool('r2', 'goto_slide', { slide_id: 's2', reason: 'q' })], st);
    expect(a.state.slideId).toBe('s1');
    expect(a.state.pendingSlideId).toBe('s2');
    expect(run([stopped('r1')], a.state).state.slideId).toBe('s2');
  });

  it('resume_presentation returns to the interrupted slide with a resume cue', () => {
    let st = run([speech(), done('r1', 'cancelled'), created('r2')], speakingS1().state).state;
    st = run([tool('r2', 'goto_slide', { slide_id: 's3', reason: 'q' }), done('r2', 'completed', false)], st).state;
    st = run([created('r3'), started('r3'), done('r3'), stopped('r3'), speech('u2'), created('r4'), tool('r4', 'resume_presentation', {})], st).state;
    const { state, commands } = run([done('r4', 'completed', false)], st);
    expect(state.slideId).toBe('s1');
    expect(state.mode).toBe('presenting');
    const cue = commands.find((c) => c.type === 'send' && c.event.type === 'conversation.item.create');
    expect(JSON.stringify(cue)).toContain('resume slide s1');
  });

  it('flags are recorded against the slide', () => {
    const st = run([speech(), created('r2'), tool('r2', 'flag_for_followup', { type: 'adverse_event', summary: 'rash' })], speakingS1().state).state;
    expect(st.flags).toEqual([{ id: 'c-flag_for_followup', type: 'adverse_event', summary: 'rash', slideId: 's1' }]);
  });
});

describe('bidirectional navigation', () => {
  it('cancels, shows the slide at once, and presents it after the cancel lands', () => {
    const a = run([{ type: 'user_navigate', slideId: 's3' }], speakingS1().state);
    expect(a.state.slideId).toBe('s3');
    expect(sent(a.commands)).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    expect(a.state.queued).toEqual({ kind: 'present', slideId: 's3', cue: 'navigated' });
    const b = run([done('r1', 'cancelled')], a.state);
    expect(responseCreates(b.commands)).toEqual([{ kind: 'present', slide_id: 's3' }]);
  });

  it('ignores unknown slide ids', () => {
    const { state, commands } = run([{ type: 'user_navigate', slideId: 'nope' }], speakingS1().state);
    expect(state.slideId).toBe('s1');
    expect(commands).toEqual([]);
  });
});

describe('text fallback', () => {
  it('drives the same session: user item then answer response', () => {
    // Slide 1 had no audio, so slide 2's request is already pending when the user types.
    const { state } = run([{ type: 'connected' }, created('r1', 'present'), done('r1', 'completed', false)]);
    expect(state.response?.id).toBe(PENDING);
    const r = run([{ type: 'user_text', text: 'What about safety?', id: 't1' }], state);
    expect(sent(r.commands)).toEqual(['conversation.item.create']); // answer queued behind the pending one
    expect(r.state.turns.at(-1)).toMatchObject({ role: 'user', text: 'What about safety?' });
    // The pending present gets cancelled on arrival, then the answer fires.
    const c = run([created('r2', 'present', 's2')], r.state);
    expect(sent(c.commands)).toEqual(['response.cancel']);
    const d = run([done('r2', 'cancelled')], c.state);
    expect(responseCreates(d.commands)).toEqual([{ kind: 'answer', slide_id: 's2' }]);
    expect(d.state.mode).toBe('answering');
  });
});

describe('errors', () => {
  it('ignores benign cancel races', () => {
    const { commands } = run([srv({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'x' } })]);
    expect(commands).toEqual([]);
  });

  it('retries our response when it lost a race with a VAD response', () => {
    const st = run([{ type: 'connected' }, srv({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'x' } })]).state;
    expect(st.response).toBeNull();
    expect(st.queued).toMatchObject({ kind: 'present', slideId: 's1' });
  });
});
