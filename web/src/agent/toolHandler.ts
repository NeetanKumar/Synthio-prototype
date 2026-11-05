import type { z } from 'zod';
import { highlightableIds, isToolName, TOOL_ARGS, type FlagType, type PublicSlide } from '@msl/shared';

// Pure: (deck, current slide, tool call) -> what to tell the model + what the UI should do.
// No side effects here, so every edge case is unit-testable.

export type ToolEffect =
  | { type: 'goto'; slideId: string }
  | { type: 'highlight'; elementId: string }
  | { type: 'flag'; flag: z.infer<typeof FlagType>; summary: string }
  | { type: 'resume' }
  | { type: 'none' };

export interface ToolResult {
  /** JSON-serialisable object returned to the model as function_call_output. */
  output: Record<string, unknown>;
  effect: ToolEffect;
}

export interface ToolContext {
  slides: PublicSlide[];
  /** The slide the model believes is on screen (includes a goto queued behind audio). */
  currentSlideId: string;
}

const fail = (error: string, extra: Record<string, unknown> = {}): ToolResult => ({
  output: { ok: false, error, ...extra },
  effect: { type: 'none' },
});

export function handleToolCall(ctx: ToolContext, name: string, rawArgs: string): ToolResult {
  if (!isToolName(name)) return fail(`unknown tool "${name}"`);

  let json: unknown;
  try {
    json = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return fail('arguments are not valid JSON');
  }

  switch (name) {
    case 'goto_slide': {
      const args = TOOL_ARGS.goto_slide.safeParse(json);
      if (!args.success) return fail('invalid arguments: slide_id and reason are required');
      const slide = ctx.slides.find((s) => s.id === args.data.slide_id);
      // Return the valid IDs so the model can self-correct on the next turn.
      if (!slide) return fail(`no slide "${args.data.slide_id}"`, { valid_slide_ids: ctx.slides.map((s) => s.id) });
      if (slide.id === ctx.currentSlideId) {
        // Duplicate goto: idempotent, no re-animation.
        return { output: { ok: true, slide_id: slide.id, title: slide.title, already_showing: true }, effect: { type: 'none' } };
      }
      return { output: { ok: true, slide_id: slide.id, title: slide.title }, effect: { type: 'goto', slideId: slide.id } };
    }

    case 'highlight': {
      const args = TOOL_ARGS.highlight.safeParse(json);
      if (!args.success) return fail('invalid arguments: element_id is required');
      const current = ctx.slides.find((s) => s.id === ctx.currentSlideId);
      const ids = current ? highlightableIds(current) : [];
      if (!ids.includes(args.data.element_id)) {
        const owner = ctx.slides.find((s) => highlightableIds(s).includes(args.data.element_id));
        return fail(
          owner
            ? `"${args.data.element_id}" is on slide "${owner.id}"; call goto_slide first`
            : `no element "${args.data.element_id}" on the current slide`,
          { valid_element_ids: ids },
        );
      }
      return { output: { ok: true, element_id: args.data.element_id }, effect: { type: 'highlight', elementId: args.data.element_id } };
    }

    case 'flag_for_followup': {
      const args = TOOL_ARGS.flag_for_followup.safeParse(json);
      if (!args.success) return fail('invalid arguments: type must be adverse_event | off_label | out_of_scope');
      return {
        output: { ok: true, logged: true },
        effect: { type: 'flag', flag: args.data.type, summary: args.data.summary },
      };
    }

    case 'resume_presentation':
      return { output: { ok: true }, effect: { type: 'resume' } };
  }
}
