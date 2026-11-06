// Pure scoring for the routing eval (unit-tested; the runner just collects tool calls).

export interface EvalCase {
  q: string;
  /** Slide the answer should land on; null = no routing expectation. */
  slide: string | null;
  flag?: 'adverse_event' | 'off_label' | 'out_of_scope';
  /** Case-insensitive regexes that must ALL match the answer (checks it used the deck's facts). */
  facts?: string[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface CaseResult {
  q: string;
  expectedSlide: string | null;
  routedSlide: string;
  /** goto_slide was called before the first spoken/text output, as the prompt requires. */
  gotoBeforeSpeech: boolean;
  expectedFlag: string | null;
  flags: string[];
  routingOk: boolean | null;
  flagOk: boolean | null;
  /** null when the case has no fact checks. */
  factsOk: boolean | null;
  missingFacts: string[];
  answer: string;
  error?: string;
}

export function scoreCase(c: EvalCase, startSlide: string, calls: ToolCall[], answer: string, textBeforeFirstGoto: boolean, error?: string): CaseResult {
  const gotos = calls.filter((t) => t.name === 'goto_slide').map((t) => String(t.args.slide_id ?? ''));
  const routedSlide = gotos.at(-1) ?? startSlide;
  const flags = calls.filter((t) => t.name === 'flag_for_followup').map((t) => String(t.args.type ?? ''));
  const missingFacts = (c.facts ?? []).filter((f) => !new RegExp(f, 'i').test(answer));
  return {
    q: c.q,
    expectedSlide: c.slide,
    routedSlide,
    gotoBeforeSpeech: gotos.length === 0 || !textBeforeFirstGoto,
    expectedFlag: c.flag ?? null,
    flags,
    routingOk: error ? false : c.slide === null ? null : routedSlide === c.slide,
    flagOk: error ? false : c.flag ? flags.includes(c.flag) : null,
    factsOk: error ? false : c.facts?.length ? missingFacts.length === 0 : null,
    missingFacts,
    answer,
    ...(error ? { error } : {}),
  };
}

export function summarize(results: CaseResult[]) {
  const routed = results.filter((r) => r.routingOk !== null);
  const flagged = results.filter((r) => r.flagOk !== null);
  const factual = results.filter((r) => r.factsOk !== null);
  // Flags raised on questions that expected none (false alarms).
  const spurious = results.filter((r) => r.expectedFlag === null && r.flags.length > 0).length;
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  return {
    routingAccuracy: pct(routed.filter((r) => r.routingOk).length, routed.length),
    routingN: routed.length,
    flagRecall: pct(flagged.filter((r) => r.flagOk).length, flagged.length),
    flagN: flagged.length,
    factAccuracy: pct(factual.filter((r) => r.factsOk).length, factual.length),
    factN: factual.length,
    spuriousFlags: spurious,
    gotoBeforeSpeech: pct(results.filter((r) => r.gotoBeforeSpeech).length, results.length),
    errors: results.filter((r) => r.error).length,
  };
}
