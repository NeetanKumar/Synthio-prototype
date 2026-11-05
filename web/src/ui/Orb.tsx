import { motion } from 'motion/react';
import type { AgentState } from '../agent/machine.ts';

const LABEL: Record<AgentState, string> = {
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  interrupted: 'Interrupted',
  ended: 'Call ended',
  error: 'Disconnected',
};

const COLOR: Record<AgentState, string> = {
  connecting: '#8fa1ae',
  reconnecting: '#f2a93b',
  idle: '#8fa1ae',
  listening: '#4fd1c5',
  thinking: '#7cc4e8',
  speaking: '#14a39d',
  interrupted: '#f2a93b',
  ended: '#8fa1ae',
  error: '#e5604d',
};

/** Agent-state orb. Each state has a distinct motion, not just a colour, so it reads at a glance. */
export function Orb({ state, size = 44 }: { state: AgentState; size?: number }) {
  const c = COLOR[state];
  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite">
      <div className="relative" style={{ width: size, height: size }}>
        {/* halo */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ background: c, filter: 'blur(10px)' }}
          animate={{
            opacity: state === 'speaking' ? [0.35, 0.7, 0.35] : state === 'listening' ? 0.55 : 0.2,
            scale: state === 'speaking' ? [1, 1.25, 1] : 1,
          }}
          transition={{ duration: 1.1, repeat: state === 'speaking' ? Infinity : 0 }}
        />
        {/* core */}
        <motion.div
          className="absolute inset-[18%] rounded-full"
          style={{ background: `radial-gradient(circle at 35% 30%, #ffffffaa, ${c} 55%, ${c})` }}
          animate={{ scale: state === 'interrupted' ? [1, 0.82, 1] : state === 'listening' ? [1, 1.08, 1] : 1 }}
          transition={{ duration: state === 'interrupted' ? 0.35 : 1.4, repeat: state === 'listening' ? Infinity : 0 }}
        />
        {/* thinking arc */}
        {(state === 'thinking' || state === 'connecting' || state === 'reconnecting') && (
          <motion.svg viewBox="0 0 40 40" className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
            <circle cx="20" cy="20" r="18" fill="none" stroke={c} strokeWidth="2" strokeDasharray="28 85" strokeLinecap="round" />
          </motion.svg>
        )}
      </div>
      <span className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: c }}>
        {LABEL[state]}
      </span>
    </div>
  );
}
