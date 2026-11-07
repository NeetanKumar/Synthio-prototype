import { AnimatePresence, motion } from 'motion/react';
import { useRef } from 'react';
import type { PublicDeck } from '@msl/shared';
import { SlideView } from '../slides/SlideView.tsx';

/** 16:9 stage. Slides slide in from the direction of travel. */
export function Stage({ deck, slideId, highlightId }: { deck: PublicDeck; slideId: string; highlightId: string | null }) {
  const index = Math.max(0, deck.slides.findIndex((s) => s.id === slideId));
  const prevIndex = useRef(index);
  const dir = index >= prevIndex.current ? 1 : -1;
  prevIndex.current = index;
  const slide = deck.slides[index]!;

  return (
    <div className="@container relative aspect-video w-full overflow-hidden rounded-xl bg-paper shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] ring-1 ring-white/10">
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.div
          key={slide.id}
          className="absolute inset-0"
          custom={dir}
          initial={{ opacity: 0, x: `${dir * 6}%` }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: `${dir * -6}%` }}
          transition={{ type: 'spring', stiffness: 260, damping: 32 }}
        >
          <SlideView slide={slide} index={index} total={deck.slides.length} footer={deck.footer} highlightId={highlightId} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function ThumbRail({ deck, slideId, onSelect }: { deck: PublicDeck; slideId: string; onSelect: (id: string) => void }) {
  return (
    <nav aria-label="Slides" className="flex gap-3 overflow-x-auto pb-2 lg:max-h-[calc(100vh-120px)] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pr-1">
      {deck.slides.map((s, i) => {
        const on = s.id === slideId;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group relative w-40 shrink-0 text-left lg:w-full ${on ? '' : 'opacity-60 hover:opacity-100'} transition-opacity`}
            aria-current={on}
          >
            <div className={`@container pointer-events-none aspect-video overflow-hidden rounded-md ring-2 ${on ? 'ring-teal' : 'ring-transparent'}`}>
              <SlideView slide={s} index={i} total={deck.slides.length} footer="" highlightId={null} compact />
            </div>
            <div className="mt-1.5 flex gap-2 text-xs text-mist">
              <span className="font-mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="truncate">{s.title}</span>
            </div>
          </button>
        );
      })}
    </nav>
  );
}
