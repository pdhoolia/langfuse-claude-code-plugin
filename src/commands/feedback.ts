#!/usr/bin/env node
/**
 * /feedback up|down [comment] — turn-scope thumbs feedback.
 *
 * Bundled CLI invoked from `commands/feedback.md` via `!`bash`` injection
 * with `$ARGUMENTS` as argv. Writes a deterministic ±1 score to Langfuse
 * attached to the most recent completed substantive turn.
 *
 * Exit codes: always 0 (NFC-2: never block, never noisy).
 *
 * See EIS §3.5 for the full behaviour contract.
 */

import { debug, error } from "../logger.js";
import { initHook } from "../utils/hook-init.js";
import { initClient, postScore, flushTraces, shutdownClient } from "../langfuse.js";
import { parseArgs, isParseError } from "../scoring/parse.js";
import { computeScoreId } from "../scoring/id.js";
import { resolveFeedbackTarget, isLookupFailure } from "../scoring/lookup.js";

const SCORE_NAME = "turn_feedback";
const USAGE_HINT = "Usage: /feedback up|down [optional comment]";
const FLUSH_TIMEOUT_MS = 2_000;

async function main(): Promise<void> {
  // 1. Kill switch + credentials.
  const config = initHook();
  if (!config) return;

  // 2. Parse argv. Slash command CLIs receive $ARGUMENTS as a single string,
  //    but Claude Code may also split on whitespace. Joining argv.slice(2) with
  //    spaces handles both shapes.
  const argv = process.argv.slice(2).join(" ");
  const parsed = parseArgs(argv);
  if (isParseError(parsed)) {
    debug(`parseArgs: ${parsed.error}`);
    console.log(USAGE_HINT);
    if (parsed.hint) console.log(`(${parsed.hint})`);
    return;
  }

  // 3. Resolve feedback target via the unified gate (ADR-007).
  const target = resolveFeedbackTarget(config.stateFilePath, process.cwd());
  if (isLookupFailure(target)) {
    if (target.kind === "no_session") {
      debug(`lookup: no_session for cwd=${target.cwd}`);
      console.log("No traced session found for this directory. Is TRACE_TO_LANGFUSE=true?");
    } else {
      debug(`lookup: no_substantive_turn for session=${target.sessionId}`);
      console.log("No completed turn yet to score. Try /feedback after Claude has responded.");
    }
    return;
  }

  // 4. Compute deterministic score ID (ADR-004).
  const scoreId = computeScoreId(target.lastSubstantiveTraceId, SCORE_NAME);
  const value = parsed.direction === "up" ? 1 : -1;

  // 5. Post score and flush.
  initClient(config.publicKey, config.secretKey, config.baseUrl);
  let postFailed = false;
  try {
    postScore({
      id: scoreId,
      name: SCORE_NAME,
      value,
      comment: parsed.comment,
      traceId: target.lastSubstantiveTraceId,
    });
    debug(
      `score posted: id=${scoreId} name=${SCORE_NAME} value=${value > 0 ? "+1" : "-1"} ` +
        `traceId=${target.lastSubstantiveTraceId}`,
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
    const traceShort = target.lastSubstantiveTraceId.slice(0, 8);
    console.log(`✓ ${SCORE_NAME} ${valueStr} recorded for trace ${traceShort}…`);
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
    error(`feedback CLI fatal error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
