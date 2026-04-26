/**
 * Shared hook startup utilities.
 */

import { loadConfig, type Config } from "../config.js";
import { initLogger, error } from "../logger.js";

/**
 * Decide whether tracing should run for the current invocation.
 *
 * Two-knob control (introduced in v0.3.0):
 *
 *   - `TRACE_TO_LANGFUSE` is the **per-invocation override**. When explicitly
 *     set to `"true"` or `"false"` (case-insensitive), it wins outright.
 *     Typically set in a project's `.claude/settings.json` `env` block to
 *     opt that project in or out of the global default.
 *
 *   - `CC_LANGFUSE_TRACE_DEFAULT` is the **global default policy**.
 *     Typically set in `~/.claude/settings.json` `env` block. Recognized
 *     values: `"all"` (trace by default; projects can opt out) or anything
 *     else / unset (opt-in default; projects must opt in).
 *
 * Decision rule (first match wins):
 *   1. `TRACE_TO_LANGFUSE === "true"`         → trace
 *   2. `TRACE_TO_LANGFUSE === "false"`        → don't trace
 *   3. `CC_LANGFUSE_TRACE_DEFAULT === "all"`  → trace
 *   4. otherwise                              → don't trace
 *
 * Backward compatibility: rule 1 is exactly the v0.2.x kill-switch
 * behaviour, so existing users with `TRACE_TO_LANGFUSE=true` exported
 * in their shell or set globally see no change.
 *
 * Pure function — accepts `env` as an argument for testability.
 */
export function shouldTrace(env: NodeJS.ProcessEnv): boolean {
  const trace = env.TRACE_TO_LANGFUSE?.toLowerCase().trim();
  if (trace === "true") return true;
  if (trace === "false") return false;
  const policy = env.CC_LANGFUSE_TRACE_DEFAULT?.toLowerCase().trim();
  return policy === "all";
}

/**
 * Standard hook startup: load config, init logger, check kill-switch and credentials.
 * Returns the Config if tracing should proceed, null if the hook should exit early.
 */
export function initHook(): Config | null {
  const config = loadConfig();
  initLogger(config.debug);

  if (!shouldTrace(process.env)) {
    return null;
  }

  if (!config.publicKey || !config.secretKey) {
    error(
      "No Langfuse credentials set (CC_LANGFUSE_PUBLIC_KEY/CC_LANGFUSE_SECRET_KEY or LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY)",
    );
    return null;
  }

  return config;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string | undefined): string | undefined {
  return path?.replace(/^~/, process.env.HOME ?? "");
}
