/**
 * Configuration — reads from environment variables.
 */

export interface Config {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  stateFilePath: string;
  debug: boolean;
  maxChars: number;
}

export function loadConfig(): Config {
  const publicKey = process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY ?? "";

  const secretKey = process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY ?? "";

  const baseUrl =
    process.env.CC_LANGFUSE_BASE_URL ??
    process.env.LANGFUSE_BASE_URL ??
    "https://cloud.langfuse.com";

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const stateFilePath = process.env.STATE_FILE ?? `${homeDir}/.claude/state/langfuse_state.json`;

  const debug = (process.env.CC_LANGFUSE_DEBUG ?? "").toLowerCase() === "true";

  const maxChars = parseInt(process.env.CC_LANGFUSE_MAX_CHARS ?? "50000", 10);

  return { publicKey, secretKey, baseUrl, stateFilePath, debug, maxChars };
}
