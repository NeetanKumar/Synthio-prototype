import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { CallNotes, PublicDeck } from '@msl/shared';
import type { Flag, MachineState, Turn } from '../agent/machine.ts';
import { median } from '../agent/cursor.ts';

// ---------- Captions ----------

/** Live transcript for both sides. Interrupted turns show what was heard vs. cut off. */
export function Captions({ turns }: { turns: Turn[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = turns.filter((t) => t.text || t.status === 'live').slice(-30);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [visible.length, visible.at(-1)?.text]);

  return (
    <div ref={ref} className="flex h-48 flex-col gap-2.5 overflow-y-auto pr-2 text-[15px] leading-relaxed" aria-live="polite">
      {visible.length === 0 && <p className="text-mist/70">Captions appear here.</p>}
      {visible.map((t) => (
        <div key={t.id} className={`flex gap-3 ${t.role === 'user' ? 'text-[#c9d5dd]' : 'text-paper'}`}>
          <span className={`mt-[3px] w-12 shrink-0 font-mono text-[11px] uppercase tracking-wider ${t.role === 'user' ? 'text-mist' : 'text-[#4fd1c5]'}`}>
            {t.role === 'user' ? 'You' : 'Agent'}
          </span>
          <p className="min-w-0">
            {t.status === 'interrupted' && t.heardChars !== undefined ? (
              <>
                {t.text.slice(0, t.heardChars)}
                <span className="text-mist/60 line-through decoration-laser/70">{t.text.slice(t.heardChars)}</span>
                <span className="ml-2 rounded bg-laser/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-laser">interrupted</span>
              </>
            ) : (
              <>
                {t.text || <span className="text-mist">…</span>}
                {t.status === 'live' && <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-current" />}
              </>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------- Compliance toasts ----------

const FLAG_META: Record<Flag['type'], { label: string; tone: string }> = {
  adverse_event: { label: 'Adverse event logged · route to pharmacovigilance', tone: 'border-alert/60 bg-[#3a1d1a] text-[#ffb4a8]' },
  off_label: { label: 'Off-label question flagged', tone: 'border-laser/60 bg-[#3a2c14] text-[#ffd79a]' },
  out_of_scope: { label: 'Out of scope · follow-up needed', tone: 'border-mist/40 bg-night-3 text-[#c9d5dd]' },
};

export function FlagToasts({ flags }: { flags: Flag[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    const timers = flags
      .filter((f) => !hidden.has(f.id))
      .map((f) => setTimeout(() => setHidden((h) => new Set(h).add(f.id)), 7000));
    return () => timers.forEach(clearTimeout);
  }, [flags, hidden]);

  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-40 flex w-[360px] max-w-[calc(100vw-40px)] flex-col gap-2">
      <AnimatePresence>
        {flags
          .filter((f) => !hidden.has(f.id))
          .map((f) => (
            <motion.div
              key={f.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40 }}
              className={`pointer-events-auto rounded-xl border px-4 py-3 shadow-2xl ${FLAG_META[f.type].tone}`}
              role="alert"
            >
              <div className="font-mono text-[11px] uppercase tracking-wider">{FLAG_META[f.type].label}</div>
              <div className="mt-1 text-sm text-paper/90">{f.summary}</div>
            </motion.div>
          ))}
      </AnimatePresence>
    </div>
  );
}

// ---------- Mic level ----------

/** Reads the analyser on animation frames and writes styles directly: no React re-render per frame. */
export function MicMeter({ getLevel, disabled }: { getLevel: () => number; disabled: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const level = getLevel();
      bars.current.forEach((el, i) => {
        if (!el) return;
        const on = level * bars.current.length > i;
        el.style.opacity = on ? '1' : '0.18';
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getLevel]);

  if (disabled) return <span className="font-mono text-[11px] uppercase tracking-wider text-alert">Mic off</span>;
  return (
    <div className="flex h-5 items-end gap-[3px]" aria-label="Microphone level">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} className="w-[3px] rounded-full bg-[#4fd1c5] opacity-20" style={{ height: `${30 + i * 7}%` }} />
      ))}
    </div>
  );
}

// ---------- Countdown ----------

export function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, deadline - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span className={`font-mono text-xs tabular ${left < 60000 ? 'text-laser' : 'text-mist'}`} title="Session limit (cost guard)">
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

// ---------- Text input (fallback + quiet-room option) ----------

export function TextAsk({ onSend, micDenied }: { onSend: (t: string) => void; micDenied: boolean }) {
  const [text, setText] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(text);
        setText('');
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={micDenied ? 'Microphone unavailable. Type your question…' : 'Or type a question…'}
        className="min-w-0 flex-1 rounded-lg bg-night-3 px-3 py-2 text-sm text-paper outline-none ring-1 ring-white/10 placeholder:text-mist/70 focus:ring-teal"
      />
      <button className="rounded-lg bg-teal px-4 text-sm text-paper hover:bg-[#12807c]" disabled={!text.trim()}>
        Ask
      </button>
    </form>
  );
}

// ---------- Dev HUD ----------

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

export function DevHud({ m, model, vad }: { m: MachineState; model: string | null; vad: string }) {
  const rows: Array<[string, string]> = [
    ['model', model ?? '—'],
    ['vad', vad],
    ['state', `${m.agent} · ${m.mode}`],
    ['ttfa last', fmt(m.metrics.ttfaMs.at(-1))],
    ['ttfa p50', `${fmt(median(m.metrics.ttfaMs))}  (n=${m.metrics.ttfaMs.length})`],
    ['interrupt→silence', `local 0 ms · server ${fmt(median(m.metrics.interruptMs))}`],
    ['interruptions', String(m.metrics.interruptions)],
    ['tool calls', String(m.metrics.toolCalls)],
    ['responses', String(m.metrics.responses)],
    ['speech rate', `${(m.charsPerMs * 1000).toFixed(1)} chars/s`],
    ['resume cursor', m.resume ? `${m.resume.slideId} · ${m.resume.lastSentence ? `“${m.resume.lastSentence.slice(0, 32)}…”` : 'slide start'}` : '—'],
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-5 left-5 z-40 w-[330px] rounded-xl border border-white/10 bg-night/95 p-4 font-mono text-[11px] shadow-2xl backdrop-blur"
    >
      <div className="mb-2 flex justify-between text-[#4fd1c5] uppercase tracking-wider">
        <span>Dev HUD</span>
        <span className="text-mist">press D</span>
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-mist">{k}</dt>
            <dd className="truncate text-paper">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[10px] leading-snug text-mist">
        TTFA is measured from the server&apos;s end-of-speech event to first audio; add the VAD silence window (450 ms) for the user-perceived delay.
        Local silence is immediate: audio is muted when speech is detected.
      </p>
    </motion.div>
  );
}

// ---------- Call notes ----------

/** Facts come from the session log (server) or local state as fallback; only the summary paragraph is LLM-written. */
export function CallNotesView({
  deck,
  m,
  notes,
  loading,
  onClose,
}: {
  deck: PublicDeck;
  m: MachineState;
  notes: CallNotes | null;
  loading: boolean;
  onClose: () => void;
}) {
  const title = (id: string) => deck.slides.find((s) => s.id === id)?.title ?? id;
  const num = (id: string) => String(deck.slides.findIndex((s) => s.id === id) + 1).padStart(2, '0');
  const questions = notes?.questions ?? m.questions.filter((q) => q.text && q.slideId).map((q) => ({ text: q.text, slideId: q.slideId!, slideTitle: title(q.slideId!), via: q.via }));
  const flags = notes?.flags ?? m.flags.map((f) => ({ flag: f.type, summary: f.summary, slideId: f.slideId }));
  const visited = notes?.slidesVisited ?? m.visited;

  return (
    <motion.div className="fixed inset-0 z-50 grid place-items-center bg-night/80 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-paper p-8 text-ink shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.14em] text-teal">Call notes</div>
            <h2 className="mt-1 font-serif text-4xl">{deck.title}</h2>
          </div>
          <button onClick={onClose} className="rounded-full px-3 py-1 text-sm text-ink-soft hover:bg-black/5" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-6 grid grid-cols-4 gap-3 text-center">
          <Stat label="Duration" value={notes ? `${Math.max(1, Math.round(notes.durationMs / 60000))} min` : '—'} />
          <Stat label="Questions" value={String(questions.length)} />
          <Stat label="Flags" value={String(flags.length)} />
          <Stat label="Slides seen" value={`${visited.length}/${deck.slides.length}`} />
        </div>

        <Section title="Summary">
          {loading ? (
            <p className="text-ink-soft">Writing summary…</p>
          ) : notes?.narrative ? (
            <p className="leading-relaxed">{notes.narrative}</p>
          ) : (
            <p className="text-ink-soft">Summary unavailable. The facts below come straight from the session log.</p>
          )}
        </Section>

        <Section title="Questions asked">
          {questions.length === 0 ? (
            <p className="text-ink-soft">No questions.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {questions.map((q, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
                  <span>“{q.text}”</span>
                  <span className="shrink-0 rounded-full bg-teal-soft px-2.5 py-0.5 font-mono text-[11px] text-teal">
                    → {num(q.slideId)} {q.slideTitle.slice(0, 28)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Compliance flags">
          {flags.length === 0 ? (
            <p className="text-ink-soft">None raised.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {flags.map((f, i) => (
                <li key={i} className="flex gap-3">
                  <span className={`shrink-0 rounded px-2 py-0.5 font-mono text-[11px] uppercase ${f.flag === 'adverse_event' ? 'bg-alert/15 text-alert' : 'bg-laser/20 text-[#9a6412]'}`}>
                    {f.flag.replace('_', ' ')}
                  </span>
                  <span>{f.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <p className="mt-8 border-t border-rule pt-3 text-xs text-ink-soft">{deck.footer}</p>
      </motion.div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-teal-soft/60 px-2 py-3">
      <div className="font-serif text-3xl text-teal">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-ink-soft">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="mb-3 font-mono text-xs uppercase tracking-[0.14em] text-ink-soft">{title}</h3>
      {children}
    </section>
  );
}
