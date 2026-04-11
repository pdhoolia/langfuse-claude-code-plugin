/**
 * Shared hook startup utilities.
 */

import { loadConfig, type Config } from "../config.js";
import { initLogger, error } from "../logger.js";

/**
 * Standard hook startup: load config, init logger, check kill-switch and credentials.
 * Returns the Config if tracing should proceed, null if the hook should exit early.
 */
export function initHook(): Config | null {
  const config = loadConfig();
  initLogger(config.debug);

  if (process.env.TRACE_TO_LANGFUSE?.toLowerCase() !== "true") {
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
