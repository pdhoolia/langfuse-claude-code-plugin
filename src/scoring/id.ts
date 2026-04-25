/**
 * Deterministic, idempotent score ID generation.
 *
 * Matches the Python reference in `context-gateway/src/core/observability/
 * session_scoring.py::_deterministic_score_id` byte-for-byte. Same inputs
 * always produce the same output ID, enabling Langfuse's score-upsert behaviour
 * (correctability for users; offline-scorer co-write compatibility).
 *
 * See ADR-004 (the algorithm choice) and ADR-005 (self-implementation rationale).
 */

import { createHash } from "node:crypto";

/**
 * Compute a deterministic UUID-formatted score ID for a (target, score-name) pair.
 *
 * Algorithm (mirrors the Python reference exactly):
 *   1. UTF-8 encode `${targetId}:${name}`
 *   2. SHA-256 the bytes
 *   3. Take the first 16 bytes of the digest
 *   4. Format as a UUID string (8-4-4-4-12 hex digits, lowercase)
 *
 * The output is NOT a real RFC 4122 UUID — version/variant bits are SHA-256
 * derived rather than set per spec. Langfuse stores score IDs as opaque strings,
 * so this is a cosmetic concern only. The UUID-shape is for dashboard display
 * consistency.
 *
 * @param targetId  The trace ID (turn-scope) or session ID (session-scope).
 * @param name      The score name, e.g. `"turn_feedback"` or `"session_feedback"`.
 * @returns A UUID-formatted string suitable as a Langfuse score `id`.
 */
export function computeScoreId(targetId: string, name: string): string {
  const digest = createHash("sha256").update(`${targetId}:${name}`).digest();
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
