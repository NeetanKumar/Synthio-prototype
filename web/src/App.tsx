import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PublicDeck } from '@msl/shared';
import { AgentController } from './agent/controller.ts';
import { Orb } from './ui/Orb.tsx';
import { Stage, ThumbRail } from './ui/Stage.tsx';

const params = new URLSearchParams(location.search);
const DECK_ID = params.get('deck') ?? 'lumirexa';
const VAD = params.get('vad') === 'semantic' ? 'semantic' : 'server';

export function App() {
  const [deck, setDeck] = useState<PublicDeck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/decks/${encodeURIComponent(DECK_ID)}`)
      .then((r) => (r.ok ? (r.json() as Promise<PublicDeck>) : Promise.reject(new Error(`Deck "${DECK_ID}" not found`))))
      .then(setDeck)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  if (loadError) return <Centered>{loadError}</Centered>;
  if (!deck) return <Centered>Loading deck…</Centered>;
  return <Session deck={deck} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-mist">{children}</div>;
}

function Session({ deck }: { deck: PublicDeck }) {
  // Remote audio plays through a detached element; muting it is our instant barge-in.
  const [audioEl] = useState(() => new Audio());
  const ctl = useMemo(() => new AgentController(deck, audioEl, { deckId: DECK_ID, vad: VAD }), [deck, audioEl]);
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  const m = snap.machine;
  const live = snap.phase === 'live';

  useEffect(() => () => ctl.end(), [ctl]);

  // Keyboard: Space = barge-in stop, arrows = navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = deck.slides.findIndex((s) => s.id === ctl.getSnapshot().machine.slideId);
      if (e.code === 'Space') {
        e.preventDefault();
        if (ctl.getSnapshot().phase === 'live') ctl.stop();
      } else if (e.key === 'ArrowRight' && deck.slides[idx + 1]) ctl.navigate(deck.slides[idx + 1]!.id);
      else if (e.key === 'ArrowLeft' && idx > 0) ctl.navigate(deck.slides[idx - 1]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl, deck]);

  const idx = deck.slides.findIndex((s) => s.id === m.slideId);
  const lastAssistant = [...m.turns].reverse().find((t) => t.role === 'assistant');
  const lastUser = [...m.turns].reverse().find((t) => t.role === 'user');
  const canResume = live && (m.mode === 'paused' || m.mode === 'answering') && !m.response && m.agent !== 'speaking';

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="font-serif text-2xl italic text-paper">MSL·Live</span>
          <span className="hidden text-sm text-mist sm:inline">{deck.title}</span>
        </div>
        <div className="flex items-center gap-4">
          {live || snap.phase === 'ended' ? <Orb state={m.agent} /> : null}
          {live ? (
            <button onClick={() => ctl.end()} className="rounded-full border border-white/15 px-4 py-2 text-sm text-mist hover:border-alert hover:text-alert">
              End call
            </button>
          ) : (
            <button
              onClick={() => void ctl.start()}
              disabled={snap.phase === 'starting'}
              className="rounded-full bg-teal px-5 py-2 text-sm font-medium text-paper shadow-[0_0_0_4px_rgba(14,110,107,0.25)] hover:bg-[#12807c] disabled:opacity-60"
            >
              {snap.phase === 'starting' ? 'Connecting…' : snap.phase === 'ended' ? 'Start again' : 'Start briefing'}
            </button>
          )}
        </div>
      </header>

      {snap.error && <div className="rounded-lg border border-alert/40 bg-alert/10 px-4 py-2 text-sm text-alert">{snap.error}</div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
        <main className="flex flex-col gap-4">
          <Stage deck={deck} slideId={m.slideId} highlightId={m.highlightId} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CtlButton onClick={() => idx > 0 && ctl.navigate(deck.slides[idx - 1]!.id)} disabled={idx <= 0} label="Previous slide">←</CtlButton>
              <CtlButton onClick={() => deck.slides[idx + 1] && ctl.navigate(deck.slides[idx + 1]!.id)} disabled={idx >= deck.slides.length - 1} label="Next slide">→</CtlButton>
            </div>
            {live && (
              <div className="flex items-center gap-2">
                {canResume && (
                  <button onClick={ctl.resume} className="rounded-full border border-teal/60 px-4 py-2 text-sm text-[#4fd1c5] hover:bg-teal/20">
                    Resume presentation
                  </button>
                )}
                <button onClick={ctl.stop} className="rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15" title="Space">
                  ■ Stop <kbd className="ml-1 font-mono text-xs text-mist">Space</kbd>
                </button>
              </div>
            )}
          </div>

          {/* Minimal captions (full caption panel lands in P1). */}
          {live && (
            <div className="grid gap-2 rounded-xl bg-night-2 p-4 text-sm ring-1 ring-white/5">
              {lastUser && (
                <p className="text-mist">
                  <span className="mr-2 font-mono text-xs uppercase tracking-wider">You</span>
                  {lastUser.text || '…'}
                </p>
              )}
              {lastAssistant && (
                <p className={lastAssistant.status === 'interrupted' ? 'text-[#e8c48a]' : 'text-paper'}>
                  <span className="mr-2 font-mono text-xs uppercase tracking-wider text-[#4fd1c5]">Agent</span>
                  {lastAssistant.text}
                  {lastAssistant.status === 'interrupted' && <span className="ml-2 font-mono text-xs uppercase text-laser">— interrupted</span>}
                </p>
              )}
              {snap.micDenied && <TextAsk onSend={ctl.sendText} />}
            </div>
          )}
        </main>

        <aside>
          <ThumbRail deck={deck} slideId={m.slideId} onSelect={ctl.navigate} />
        </aside>
      </div>
    </div>
  );
}

function CtlButton({ children, label, ...rest }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button aria-label={label} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-lg hover:bg-white/15 disabled:opacity-30" {...rest}>
      {children}
    </button>
  );
}

function TextAsk({ onSend }: { onSend: (t: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="mt-1 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(text);
        setText('');
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Microphone unavailable. Type a question…"
        className="flex-1 rounded-lg bg-night-3 px-3 py-2 text-paper outline-none ring-1 ring-white/10 focus:ring-teal"
      />
      <button className="rounded-lg bg-teal px-4 text-paper">Ask</button>
    </form>
  );
}
