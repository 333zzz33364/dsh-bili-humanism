// Public live-event/stop-boundary contract pinned to DSH 0.2.1-rc.2.
// No historical file crawl, timer, idle-agent wake or independent model client.
import { safeError } from "./errors.mjs";
export function attachPersonalityShadow(ctx, shadow) {
  if (!shadow.enabled) return;
  const contain =
    (fn) =>
    (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        shadow.lastError = safeError(error).error;
      }
    };
  ctx.on(
    "session/event",
    contain((session, event) => shadow.observe(session, event)),
  );
  ctx.on(
    "agent/turn-stopping",
    contain((payload) => shadow.continue(payload)),
  );
  // Host-scoped guard also blocks other plugins' tools during this review phase.
  // It ends at the stop boundary or when an actual new human message arrives.
  ctx.tools.guard((exec) => {
    if (
      exec.agent?.id &&
      shadow.store.getControl("shadow:review-phase:" + exec.agent.id) &&
      exec.name !== "bili_humanism_shadow"
    )
      return "SHADOW_REVIEW_TOOLS_ONLY";
  });
  ctx.effect(() => () => {
    shadow.closed = true;
  });
}
