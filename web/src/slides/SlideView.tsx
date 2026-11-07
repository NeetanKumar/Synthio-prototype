import type { Element, PublicSlide } from '@msl/shared';
import { BulletEl, ChartEl, FlowEl, StatEl, TableEl } from './elements.tsx';

// Layout is derived from the element kinds, so any deck JSON renders sensibly
// without per-slide layout code.

function renderEl(el: Element, highlightId: string | null, compact = false) {
  switch (el.kind) {
    case 'bullet':
      return <BulletEl key={el.id} el={el} active={el.id === highlightId} />;
    case 'stat':
      return <StatEl key={el.id} el={el} active={el.id === highlightId} />;
    case 'chart':
      return <ChartEl key={el.id} el={el} highlightId={highlightId} compact={compact} />;
    case 'table':
      return <TableEl key={el.id} el={el} highlightId={highlightId} />;
    case 'flow':
      return <FlowEl key={el.id} el={el} highlightId={highlightId} />;
  }
}

export function SlideView({
  slide,
  index,
  total,
  footer,
  highlightId,
  compact = false,
}: {
  slide: PublicSlide;
  index: number;
  total: number;
  footer: string;
  highlightId: string | null;
  /** Thumbnail rendering: no chart axes/labels or animation. */
  compact?: boolean;
}) {
  const visual = slide.elements.find((e) => e.kind === 'chart' || e.kind === 'table' || e.kind === 'flow');
  const stats = slide.elements.filter((e) => e.kind === 'stat');
  const bullets = slide.elements.filter((e) => e.kind === 'bullet');

  const bulletList = (cols: 1 | 2 = 1) =>
    bullets.length > 0 && (
      <ul className={`grid gap-x-[4cqw] gap-y-[1.3cqw] pl-[1.4cqw] ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {bullets.map((b) => renderEl(b, highlightId))}
      </ul>
    );

  let body;
  if (visual?.kind === 'flow') {
    body = (
      <div className="flex h-full flex-col justify-center gap-[3.2cqw]">
        {renderEl(visual, highlightId)}
        {bulletList(2)}
      </div>
    );
  } else if (visual) {
    body = (
      <div className="grid h-full grid-cols-12 gap-[3cqw]">
        <div className="col-span-8 min-h-0">{renderEl(visual, highlightId, compact)}</div>
        <div className="col-span-4 flex flex-col justify-center gap-[1.6cqw]">
          {stats.map((s) => renderEl(s, highlightId))}
          {bulletList()}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="grid h-full grid-cols-12 items-center gap-[3cqw]">
        {stats.length > 0 && <div className="col-span-5 flex flex-col gap-[1.6cqw]">{stats.map((s) => renderEl(s, highlightId))}</div>}
        <div className={stats.length > 0 ? 'col-span-7' : 'col-span-12'}>{bulletList()}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-paper px-[5cqw] pt-[3.6cqw] pb-[2.2cqw] text-ink">
      <header>
        {slide.kicker && <div className="font-mono text-[1.15cqw] uppercase tracking-[0.14em] text-teal">{slide.kicker}</div>}
        <h2 className="mt-[0.6cqw] max-w-[80%] font-serif text-[3.7cqw] leading-[1.05]">{slide.title}</h2>
      </header>
      <div className="mt-[2.6cqw] min-h-0 flex-1">{body}</div>
      <footer className="mt-[1.6cqw] flex items-center justify-between border-t border-rule pt-[0.9cqw] text-[1cqw] text-ink-soft">
        <span className="font-medium">{footer}</span>
        <span className="font-mono tabular">
          {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
      </footer>
    </div>
  );
}
