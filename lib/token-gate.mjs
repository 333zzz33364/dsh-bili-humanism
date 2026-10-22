import { need } from "./errors.mjs";

export const DEFAULT_READ_TOKENS = 600_000;
export const READ_TOKEN_ESTIMATE = "segment_text_utf8_bytes";

// No tokenizer/model is bundled. One UTF-8 byte counts as one estimated token,
// deliberately conservative; this is not provider usage or a billing limit.
export function readTokenLimit(config = {}) {
  for (const key of ["maxReadTokens", "maxSessionTokens"])
    if (config[key] !== undefined)
      need(
        Number.isSafeInteger(config[key]) && config[key] > 0,
        "INVALID_TOKEN_LIMIT",
      );
  return config.maxReadTokens ?? config.maxSessionTokens ?? DEFAULT_READ_TOKENS;
}

export function checkReadTokenBudget(
  store,
  segments,
  limit = DEFAULT_READ_TOKENS,
) {
  need(Number.isSafeInteger(limit) && limit > 0, "INVALID_TOKEN_LIMIT");
  const used = segments.reduce(
    (total, segment) => total + Buffer.byteLength(segment.text, "utf8"),
    0,
  );
  const status = {
    kind: "estimated_source_tokens",
    scope: "per_transcript",
    estimate: READ_TOKEN_ESTIMATE,
    used,
    limit,
    allowed: used <= limit,
  };
  // A failed transcript is observable, but never spends the next fetch's limit.
  // Old token-session/token-status controls remain untouched for rollback.
  store.setControl("read-token-status", status);
  need(status.allowed, "READ_TOKEN_BUDGET");
  return status;
}
