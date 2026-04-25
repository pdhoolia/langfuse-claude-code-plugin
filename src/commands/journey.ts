#!/usr/bin/env node
/**
 * /journey up|down [comment] — session-scope thumbs feedback.
 *
 * Bundled CLI invoked from `commands/journey.md` via `!`bash`` injection
 * with `$ARGUMENTS` as argv. Writes a deterministic ±1 score to Langfuse
 * attached to the current session.
 *
 * The unified scorability gate (ADR-007) requires at least one substantive
 * turn to have completed in this session, even though the score itself is
 * attached to the session (not a trace).
 *
 * Exit codes: always 0 (NFC-2: never block, never noisy).
 *
 * See EIS §3.6 for the full behaviour contract.
 */

import { debug, error } from "../logger.js";
import { initHook } from "../utils/hook-init.js";
import { initClient, postScore, flushTraces, shutdownClient } from "../langfuse.js";
import { parseArgs, isParseError } from "../scoring/parse.js";
import { computeScoreId } from "../scoring/id.js";
import { resolveFeedbackTarget, isLookupFailure } from "../scoring/lookup.js";

const SCORE_NAME = "session_feedback";
const USAGE_HINT = "Usage: /journey up|down [optional comment]";
const FLUSH_TIMEOUT_MS = 2_000;

async function main(): Promise<void> {
  // 1. Kill switch + credentials.
  const config = initHook();
  if (!config) return;

  // 2. Parse argv.
  const argv = process.argv.slice(2).join(" ");
  const parsed = parseArgs(argv);
  if (isParseError(parsed)) {
    debug(`parseArgs: ${parsed.error}`);
    console.log(USAGE_HINT);
    if (parsed.hint) console.log(`(${parsed.hint})`);
    return;
  }

  // 3. Resolve target — same gate as /feedback (ADR-007), even though we only
  //    use sessionId in the score body.
  const target = resolveFeedbackTarget(config.stateFilePath, process.cwd());
  if (isLookupFailure(target)) {
    if (target.kind === "no_session") {
      debug(`lookup: no_session for cwd=${target.cwd}`);
      console.log("No traced session found for this directory. Is TRACE_TO_LANGFUSE=true?");
    } else {
      debug(`lookup: no_substantive_turn for session=${target.sessionId}`);
      console.log(
        "No conversation yet to score. Try /journey after Claude has responded at least once.",
      );
    }
    return;
  }

  // 4. Compute deterministic score ID — keyed on sessionId for session-scope.
  const scoreId = computeScoreId(target.sessionId, SCORE_NAME);
  const value = parsed.direction === "up" ? 1 : -1;

  // 5. Post score (sessionId attachment, no traceId) and flush.
  initClient(config.publicKey, config.secretKey, config.baseUrl);
  let postFailed = false;
  try {
    postScore({
      id: scoreId,
      name: SCORE_NAME,
      value,
      comment: parsed.comment,
      sessionId: target.sessionId,
    });
    debug(
      `score posted: id=${scoreId} name=${SCORE_NAME} value=${value > 0 ? "+1" : "-1"} ` +
        `sessionId=${target.sessionId}`,
    );
    await flushWithTimeout(FLUSH_TIMEOUT_MS);
  } catch (err) {
    postFailed = true;
    error(`score() failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    await shutdownClient();
  }

  // 6. Confirmation to user.
  if (postFailed) {
    console.log("Feedback recorded locally; sync may be delayed.");
  } else {
    const valueStr = value > 0 ? "+1" : "-1";
    const sessionShort = target.sessionId.slice(0, 8);
    console.log(`✓ ${SCORE_NAME} ${valueStr} recorded for session ${sessionShort}…`);
  }
}

/** Race the flush against a timeout (NFC-6). Always resolves; never throws. */
async function flushWithTimeout(timeoutMs: number): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  try {
    await Promise.race([flushTraces(), timeout]);
  } catch (err) {
    error(`flush failed: ${err}`);
  }
}

main().catch((err) => {
  try {
    error(`journey CLI fatal error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
