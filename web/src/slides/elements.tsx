import { motion } from 'motion/react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { Element } from '@msl/shared';

// All sizes are in cqw (percent of the stage width) so a slide looks identical
// at any window size, like a real 16:9 deck.

type Of<K extends Element['kind']> = Extract<Element, { kind: K }>;

/** The "laser pointer": an amber bar that slides in next to the active element. */
function Laser({ on }: { on: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="absolute -left-[1.4cqw] top-[0.2em] bottom-[0.2em] w-[0.35cqw] rounded-full"
      initial={false}
      animate={{ opacity: on ? 1 : 0.45, scaleY: on ? 1 : 0.35, backgroundColor: on ? 'var(--color-laser)' : 'var(--color-teal)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
    />
  );
}

export function BulletEl({ el, active }: { el: Of<'bullet'>; active: boolean }) {
  return (
    <li className="relative list-none" data-active={active}>
      <Laser on={active} />
      <span className={`block text-[1.75cqw] leading-snug transition-colors ${active ? 'text-ink' : 'text-ink-soft'}`}>{el.text}</span>
    </li>
  );
}

export function StatEl({ el, active }: { el: Of<'stat'>; active: boolean }) {
  return (
    <div className={`relative rounded-[0.6cqw] p-[1.6cqw] transition-colors ${active ? 'bg-laser/15' : 'bg-teal-soft'}`}>
      <div className="font-serif text-[6.2cqw] leading-none text-teal tabular">{el.value}</div>
      <div className="mt-[0.8cqw] text-[1.45cqw] leading-snug text-ink-soft">{el.label}</div>
    </div>
  );
}

export function ChartEl({ el, highlightId, compact = false }: { el: Of<'chart'>; highlightId: string | null; compact?: boolean }) {
  const data = el.groups.map((g) => ({ id: g.id, label: g.label, a: g.values[0], b: g.values[1] }));
  const focus = el.groups.some((g) => g.id === highlightId) ? highlightId : null;
  const dim = (id: string) => (focus && focus !== id ? 0.25 : 1);
  // Headroom above the tallest bar for its value label, rounded to a tidy tick.
  const yMax = Math.ceil((Math.max(...el.groups.flatMap((g) => g.values)) * 1.2) / 10) * 10;
  return (
    <figure className="flex h-full flex-col">
      <figcaption className="mb-[0.8cqw] flex items-center justify-between">
        <span className="text-[1.35cqw] font-medium uppercase tracking-[0.08em] text-ink-soft">{el.title}</span>
        <span className="flex gap-[1.6cqw] text-[1.2cqw] text-ink-soft">
          <Legend color="var(--color-teal)" label={el.arms[0]} />
          <Legend color="var(--color-vehicle)" label={el.arms[1]} />
        </span>
      </figcaption>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={4} barCategoryGap="22%" margin={compact ? { top: 4, right: 0, bottom: 0, left: 0 } : { top: 28, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid vertical={false} stroke="var(--color-rule)" />
            <XAxis dataKey="label" hide={compact} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-ink)', fontSize: 13, fontFamily: 'IBM Plex Sans' }} />
            <YAxis hide={compact} domain={[0, yMax]} tickLine={false} axisLine={false} tick={{ fill: 'var(--color-ink-soft)', fontSize: 11, fontFamily: 'IBM Plex Mono' }} unit={el.unit} />
            <Bar dataKey="a" radius={[3, 3, 0, 0]} isAnimationActive={!compact} animationDuration={900}>
              {data.map((d) => (
                <Cell key={d.id} fill="var(--color-teal)" fillOpacity={dim(d.id)} />
              ))}
              {!compact && <LabelList dataKey="a" position="top" formatter={(v) => `${String(v)}${el.unit}`} style={{ fill: 'var(--color-ink)', fontFamily: 'IBM Plex Mono', fontSize: 13 }} />}
            </Bar>
            <Bar dataKey="b" radius={[3, 3, 0, 0]} isAnimationActive={!compact} animationDuration={900}>
              {data.map((d) => (
                <Cell key={d.id} fill="var(--color-vehicle)" fillOpacity={dim(d.id)} />
              ))}
              {!compact && <LabelList dataKey="b" position="top" formatter={(v) => `${String(v)}${el.unit}`} style={{ fill: 'var(--color-ink-soft)', fontFamily: 'IBM Plex Mono', fontSize: 12 }} />}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {el.footnote && <p className="mt-[0.6cqw] text-[1.05cqw] text-ink-soft">{el.footnote}</p>}
    </figure>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-[0.5cqw]">
      <span className="inline-block h-[0.9cqw] w-[0.9cqw] rounded-[0.15cqw]" style={{ background: color }} />
      {label}
    </span>
  );
}

export function TableEl({ el, highlightId }: { el: Of<'table'>; highlightId: string | null }) {
  return (
    <figure>
      <table className="w-full border-collapse text-[1.4cqw]">
        <thead>
          <tr className="border-b-2 border-ink text-left">
            {el.columns.map((c, i) => (
              <th key={c} className={`pb-[0.6cqw] font-medium ${i > 0 ? 'text-right' : ''}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {el.rows.map((r) => {
            const on = r.id === highlightId;
            return (
              <tr key={r.id} className={`border-b border-rule transition-colors ${on ? 'bg-laser/20' : ''}`}>
                {r.cells.map((c, i) => (
                  <td key={i} className={`py-[0.55cqw] ${i > 0 ? 'text-right font-mono tabular' : ''} ${i === 0 ? 'pl-[0.6cqw]' : 'pr-[0.6cqw]'}`}>{c}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {el.footnote && <p className="mt-[0.8cqw] text-[1.05cqw] text-ink-soft">{el.footnote}</p>}
    </figure>
  );
}

/** Mechanism-of-action pathway: boxes and arrows; the drug's block is drawn on the arrow. */
export function FlowEl({ el, highlightId }: { el: Of<'flow'>; highlightId: string | null }) {
  return (
    <div className="flex items-stretch">
      {el.steps.map((step, i) => {
        const on = step.id === highlightId;
        return (
          <div key={step.id} className="flex flex-1 items-center">
            <motion.div
              className={`relative flex h-full flex-1 flex-col justify-center rounded-[0.7cqw] border px-[1.1cqw] py-[1.3cqw] ${
                step.blockedBy ? 'border-teal bg-teal text-paper' : 'border-rule bg-white/60'
              }`}
              animate={{ scale: on ? 1.05 : 1, boxShadow: on ? '0 0 0 0.3cqw var(--color-laser)' : '0 0 0 0 transparent' }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            >
              <div className="font-serif text-[2.1cqw] leading-tight">{step.label}</div>
              <div className={`mt-[0.5cqw] text-[1.1cqw] leading-snug ${step.blockedBy ? 'text-paper/80' : 'text-ink-soft'}`}>{step.caption}</div>
              {step.blockedBy && (
                <div className="absolute -top-[1.2cqw] left-1/2 -translate-x-1/2 rounded-full bg-laser px-[0.8cqw] py-[0.2cqw] font-mono text-[0.95cqw] font-medium text-ink">
                  ⊣ {step.blockedBy}
                </div>
              )}
            </motion.div>
            {i < el.steps.length - 1 && (
              <svg viewBox="0 0 24 12" className="mx-[0.4cqw] w-[2.2cqw] shrink-0 text-ink-soft" aria-hidden>
                <path d="M0 6h20M15 1l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}
