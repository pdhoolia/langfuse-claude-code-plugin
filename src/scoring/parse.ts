/**
 * Argv parser for `/feedback` and `/journey` slash commands.
 *
 * Grammar:
 *   args := DIRECTION [WHITESPACE COMMENT]
 *   DIRECTION := "up" | "down"   (case-insensitive)
 *   COMMENT := <any text including whitespace, trimmed>
 *
 * See EIS §3.2.
 */

export interface ParsedFeedbackArgs {
  direction: "up" | "down";
  comment?: string;
}

export interface ParseError {
  error: string;
  /** Command-specific usage hint to print to stdout. Caller fills it in. */
  hint: string;
}

/** Type guard for callers to discriminate the result. */
export function isParseError(result: ParsedFeedbackArgs | ParseError): result is ParseError {
  return "error" in result;
}

/**
 * Parse the raw argument string from a slash command invocation.
 *
 * The first whitespace-delimited token is the direction; everything after the
 * first run of whitespace following it (trimmed) is the optional comment.
 *
 * @param argv  Raw argument string (everything after the slash command name).
 */
export function parseArgs(argv: string): ParsedFeedbackArgs | ParseError {
  const trimmed = argv.trim();

  if (trimmed.length === 0) {
    return { error: "missing direction", hint: "received empty argument" };
  }

  // Split off the first token (direction) from the remainder (comment).
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    // Defensive — the regex above should always match a non-empty trimmed string.
    return { error: "could not parse argument", hint: `received: '${argv}'` };
  }

  const directionRaw = match[1].toLowerCase();
  if (directionRaw !== "up" && directionRaw !== "down") {
    return {
      error: `unknown direction '${match[1]}'`,
      hint: `received: '${match[1]}'`,
    };
  }

  const direction = directionRaw as "up" | "down";
  const commentRaw = match[2]?.trim();
  const comment = commentRaw && commentRaw.length > 0 ? commentRaw : undefined;

  return comment !== undefined ? { direction, comment } : { direction };
}
