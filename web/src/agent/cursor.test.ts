import { describe, expect, it } from 'vitest';
import { calibrate, heardChars, lastHeardSentence, median, splitSentences } from './cursor.ts';

describe('cursor helpers', () => {
  it('splits on sentence punctuation', () => {
    expect(splitSentences('One. Two? Three! Four')).toEqual(['One.', 'Two?', 'Three!', 'Four']);
  });
  it('clamps heard characters to the text', () => {
    expect(heardChars('hello', 10_000, 0.01)).toBe(5);
    expect(heardChars('hello', -5, 0.01)).toBe(0);
  });
  it('returns the last fully heard sentence', () => {
    const t = 'Alpha one. Beta two. Gamma three.';
    expect(lastHeardSentence(t, 9)).toBeNull();
    expect(lastHeardSentence(t, 10)).toBe('Alpha one.');
    expect(lastHeardSentence(t, 25)).toBe('Beta two.');
    expect(lastHeardSentence(t, t.length)).toBe('Gamma three.');
    expect(lastHeardSentence('Alpha one. Beta tw', 18)).toBe('Alpha one.'); // fragment ignored
  });
  it('calibrates toward the observed rate and ignores outliers', () => {
    expect(calibrate(0.015, 300, 15_000)).toBeCloseTo(0.0165, 4);
    expect(calibrate(0.015, 10, 15_000)).toBe(0.015);
    expect(calibrate(0.015, 3000, 2000)).toBe(0.015);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3);
  });
});
