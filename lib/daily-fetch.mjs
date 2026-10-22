import { candidates, readVideo } from "./reader.mjs";
import { need, safeError } from "./errors.mjs";

export const DAILY_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86400000;
const OFFSET_MS = 8 * 3600000;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const stopCodes = new Set([
  "CANCELLED",
  "WALL_BUDGET",
  "DAILY_WINDOW_CLOSED",
  "TASK_BUSY",
  "PERSISTENT_PAUSE",
  "PLATFORM_PAUSED",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_EXPIRED",
  "REQUESTS_BUDGET",
  "CANDIDATES_BUDGET",
]);

export function dailyConfig(config = {}) {
  const enabled =
    config.enableDailyFetching === undefined
      ? true
      : config.enableDailyFetching;
  const start =
    config.dailyFetchStart === undefined ? "21:30" : config.dailyFetchStart;
  const end =
    config.dailyFetchEnd === undefined ? "22:00" : config.dailyFetchEnd;
  const limit =
    config.dailyFetchLimit === undefined ? 2 : config.dailyFetchLimit;
  need(typeof enabled === "boolean", "INVALID_DAILY_CONFIG");
  need(
    typeof start === "string" && timePattern.test(start),
    "INVALID_DAILY_CONFIG",
  );
  need(
    typeof end === "string" && timePattern.test(end) && end > start,
    "INVALID_DAILY_CONFIG",
  );
  need(
    Number.isInteger(limit) && limit >= 1 && limit <= 2,
    "INVALID_DAILY_CONFIG",
  );
  return { enabled, start, end, limit, timeZone: DAILY_TIME_ZONE };
}

export function dailyWindow(at, config) {
  need(Number.isFinite(at), "INVALID_DAILY_CLOCK");
  const date = new Date(at + OFFSET_MS).toISOString().slice(0, 10);
  const start = Date.parse(`${date}T${config.start}:00+08:00`);
  const end = Date.parse(`${date}T${config.end}:00+08:00`);
  return { date, start, end, open: at >= start && at < end };
}

const keyOf = (date) => `daily-fetch:${date}`;
const summary = (reading) => ({
  readingId: reading.id,
  bvid: reading.bvid,
  page: reading.page,
  title: String(reading.title || "").slice(0, 500),
  route: reading.route,
  segmentCount: reading.segments.length,
  coverage: reading.coverage,
});

export class DailyFetcher {
  constructor(service, dependencies = {}) {
    this.service = service;
    this.config = dailyConfig(service.config);
    this.now = dependencies.now || Date.now;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
    this.running = false;
    this.timer = null;
    this.inFlight = null;
    this.nextAt = null;
  }
  status() {
    return {
      ...this.config,
      running: this.running,
      nextAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString(),
      lastRun: this.service.store.getControl("daily-fetch:last"),
      note: "Prefetches text sources only while the DSH host is running. No model calls, journals, platform writes, or next-day catch-up. Zero readable sources is reported honestly.",
    };
  }
  start() {
    if (this.running || !this.config.enabled) return;
    const last = this.service.store.getControl("daily-fetch:last");
    if (last?.status === "running" && Number.isInteger(last.pid)) {
      let exited = false;
      try {
        process.kill(last.pid, 0);
      } catch (error) {
        exited = error.code === "ESRCH";
      }
      if (exited)
        this.remember({
          ...last,
          status: "interrupted",
          error: "PROCESS_EXIT",
          finishedAt: new Date(this.now()).toISOString(),
        });
    }
    this.running = true;
    this.arm();
  }
  stop() {
    this.running = false;
    this.nextAt = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  arm(retryAt = null) {
    if (!this.running || this.service.closing) return;
    const at = this.now();
    const window = dailyWindow(at, this.config);
    const claimed = this.service.store.getControl(keyOf(window.date));
    this.nextAt =
      retryAt ??
      (at < window.start
        ? window.start
        : window.open && !claimed
          ? at + 1
          : window.start + DAY_MS);
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.inFlight = this.runDue()
          .catch(() => undefined)
          .finally(() => {
            this.inFlight = null;
            if (!this.running || this.service.closing) return;
            const current = dailyWindow(this.now(), this.config);
            const claimed = this.service.store.getControl(keyOf(current.date));
            this.arm(
              current.open && !claimed
                ? Math.min(current.end, this.now() + 30000)
                : null,
            );
          });
      },
      Math.max(1, Math.min(2147483647, this.nextAt - at)),
    );
    this.timer?.unref?.();
  }
  remember(record) {
    this.service.store.tx(() => {
      this.service.store.setControl(keyOf(record.date), record);
      this.service.store.setControl("daily-fetch:last", record);
    });
  }
  async runDue(signal) {
    const service = this.service;
    const window = dailyWindow(this.now(), this.config);
    if (!this.config.enabled || !window.open || service.closing)
      return { status: this.config.enabled ? "outside_window" : "disabled" };
    const prior = service.store.getControl(keyOf(window.date));
    if (prior) return { ...prior, deduplicated: true };
    const record = {
      date: window.date,
      timeZone: DAILY_TIME_ZONE,
      startedAt: new Date(this.now()).toISOString(),
      deadline: new Date(window.end).toISOString(),
      pid: process.pid,
      limit: this.config.limit,
      status: "running",
      entries: [],
      attempts: [],
    };
    const deadline = AbortSignal.timeout(Math.max(1, window.end - this.now()));
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let claimed = false;
    try {
      const task = await service.task(async (network, budget) => {
        budget.deadline = { at: window.end, now: this.now };
        const check = () => {
          need(
            this.now() < window.end &&
              dailyWindow(this.now(), this.config).date === window.date,
            "DAILY_WINDOW_CLOSED",
          );
          budget.check();
        };
        const existing = service.store.tx(() => {
          const saved = service.store.getControl(keyOf(window.date));
          if (saved) return saved;
          check();
          service.store.setControl(keyOf(window.date), record);
          service.store.setControl("daily-fetch:last", record);
          claimed = true;
          return null;
        });
        if (existing) return { ...existing, deduplicated: true };
        try {
          const pool = await candidates(
            network,
            Math.min(3, service.limits.candidates),
          );
          check();
          const selected = new Set();
          for (const candidate of pool) {
            if (record.entries.length >= this.config.limit) break;
            check();
            if (
              typeof candidate.bvid !== "string" ||
              !/^BV[A-Za-z0-9]{10}$/.test(candidate.bvid)
            ) {
              record.attempts.push({
                status: "invalid_candidate",
                error: "INVALID_VIDEO",
              });
              continue;
            }
            const id = `${candidate.bvid}:1`;
            if (
              service.store.hasTextReading(candidate.bvid, 1) ||
              selected.has(id)
            )
              continue;
            selected.add(id);
            try {
              const reading = await readVideo(
                candidate.bvid,
                1,
                network,
                service.store,
              );
              check();
              if (!reading.segments.length) {
                record.attempts.push({
                  bvid: reading.bvid,
                  status: "no_text_source",
                  route: reading.route,
                });
                continue;
              }
              service.sourceTokenBudget(reading);
              check();
              record.entries.push(summary(service.store.saveReading(reading)));
              this.remember(record);
            } catch (error) {
              record.attempts.push({
                ...safeError(error),
                status: "unavailable",
              });
              if (stopCodes.has(error.code)) throw error;
            }
          }
          record.status = record.entries.length
            ? "completed"
            : "no_readable_new_sources";
          return record;
        } catch (error) {
          record.status = record.entries.length ? "partial" : "failed";
          record.error =
            this.now() >= window.end
              ? "DAILY_WINDOW_CLOSED"
              : safeError(error).error;
          throw error;
        } finally {
          record.finishedAt = new Date(this.now()).toISOString();
          record.requests = budget.requests;
          this.remember(record);
        }
      }, combined);
      return task.result;
    } catch (error) {
      if (service.closing) return { status: "cancelled" };
      if (error.code === "TASK_BUSY" && !claimed)
        return { status: "deferred_busy" };
      if (!claimed) {
        record.status = "failed";
        record.error = safeError(error).error;
        record.finishedAt = new Date(this.now()).toISOString();
        this.remember(record);
      }
      return record;
    }
  }
}
