/**
 * Detect whether a user prompt is a `/feedback` or `/journey` slash command.
 *
 * Used by:
 *   - UserPromptSubmit hook (ADR-002): to skip trace allocation for feedback turns.
 *   - Stop hook (HLD §8 risk row 6): defensive double-check before promoting
 *     `current_trace_id` → `last_substantive_trace_id`.
 *
 * Recognized forms (case-sensitive on the command name; leading whitespace tolerated):
 *   /feedback ...
 *   /journey ...
 *   /langfuse-tracing:feedback ...
 *   /langfuse-tracing:journey ...
 *
 * Whether the bare or plugin-namespaced form is what Claude Code actually
 * surfaces is Q-OPEN-6 (deferred to runtime check). We accept both forms here
 * to be future-proof regardless of which is chosen.
 *
 * Comparison is on the FIRST WORD only (everything up to the first whitespace).
 * The bare command without arguments (e.g. just `/feedback`) also matches.
 */

const FEEDBACK_COMMAND_RE = /^\s*\/(?:langfuse-tracing:)?(?:feedback|journey)(?:\s|$)/;

/**
 * @returns true if the prompt is an invocation of `/feedback` or `/journey`
 *   (in any of the recognized forms).
 */
export function isFeedbackCommand(prompt: string): boolean {
  return FEEDBACK_COMMAND_RE.test(prompt);
}
