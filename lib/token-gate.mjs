import { digest } from "./store.mjs";
import { need } from "./errors.mjs";

export const DEFAULT_SESSION_TOKENS = 600_000;

// This gate cannot prevent provider overshoot within an already-running model call.
// It checks cumulative host usage before subsequent plugin work, with a durable baseline.
export function checkTokenBudget(
  store,
  sessionId,
  sample,
  limit = DEFAULT_SESSION_TOKENS,
) {
  need(Number.isSafeInteger(limit) && limit > 0, "INVALID_TOKEN_LIMIT");
  const key = "token-session:" + digest(sessionId);
  return store.tx(() => {
    const previous = store.getControl(key);
    if (!sample) {
      need(!previous, "TOKEN_METER_UNAVAILABLE");
      const state = {
        kind: "unavailable",
        used: null,
        limit,
        note: "No provider usage sample; no token cap is claimed.",
      };
      store.setControl("token-status", state);
      return state;
    }
    const buckets = [
      "uncachedInputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ];
    need(
      buckets.every((k) => Number.isFinite(sample[k]) && sample[k] >= 0),
      "INVALID_TOKEN_SAMPLE",
    );
    const total = buckets.reduce((n, k) => n + sample[k], 0);
    need(!previous || total >= previous.lastTotal, "TOKEN_COUNTER_REGRESSED");
    const state = { baseline: previous?.baseline ?? total, lastTotal: total };
    const used = total - state.baseline;
    store.setControl(key, state);
    const status = {
      kind: "provider_session_delta",
      used,
      limit,
      scope:
        "Host session provider usage since first metered plugin invocation; includes other session work. In-flight requests can overshoot.",
    };
    store.setControl("token-status", status);
    return status;
  });
}
