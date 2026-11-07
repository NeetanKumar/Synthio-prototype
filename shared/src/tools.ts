import { z } from 'zod';

// Single source of truth for tool arguments: the same zod schema produces the
// JSON schema sent to OpenAI (server) and validates the model's arguments (client).

export const GotoSlideArgs = z.object({
  slide_id: z.string().describe('ID of the slide to show. Must be one of the deck slide IDs.'),
  reason: z.string().describe('Short reason, e.g. "user asked about adverse events".'),
  // Optional pointer on the target slide: one tool call instead of goto + highlight,
  // which saves a full model round trip before the agent can speak.
  element_id: z.string().optional().describe('Optional: element on the target slide to point at (same IDs as highlight).'),
});

export const HighlightArgs = z.object({
  element_id: z.string().describe('ID of a bullet, chart bar group, table row or diagram step on the CURRENT slide.'),
});

export const FlagType = z.enum(['adverse_event', 'off_label', 'out_of_scope']);

export const FlagArgs = z.object({
  type: FlagType,
  summary: z.string().describe('One sentence, factual, no speculation.'),
});

export const ResumeArgs = z.object({});

export const EndCallArgs = z.object({});

export const TOOL_ARGS = {
  goto_slide: GotoSlideArgs,
  highlight: HighlightArgs,
  flag_for_followup: FlagArgs,
  resume_presentation: ResumeArgs,
  end_call: EndCallArgs,
} as const;

export type ToolName = keyof typeof TOOL_ARGS;
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_ARGS, name);
}

const DESCRIPTIONS: Record<ToolName, string> = {
  goto_slide:
    'Show a different slide. Call this BEFORE saying anything about content that lives on another slide.',
  highlight: 'Visually point at one element on the current slide while you talk about it.',
  flag_for_followup:
    'Log a compliance follow-up: adverse_event when the user reports a patient side effect, off_label for uses outside the label, out_of_scope for anything the deck cannot answer.',
  resume_presentation:
    'Continue the scripted presentation. After goto_slide in the same turn it continues from that slide; otherwise from where it was interrupted.',
  end_call: 'End the briefing when the user wants to stop for good. Then say one short goodbye sentence.',
};

export interface FunctionToolDef {
  type: 'function';
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export function toolDefinitions(): FunctionToolDef[] {
  return TOOL_NAMES.map((name) => {
    // z.toJSONSchema adds a "$schema" key the Realtime API doesn't need.
    const { $schema: _s, ...parameters } = z.toJSONSchema(TOOL_ARGS[name]) as Record<string, unknown>;
    return { type: 'function', name, description: DESCRIPTIONS[name], parameters };
  });
}
