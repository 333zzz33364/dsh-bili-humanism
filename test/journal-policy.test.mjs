import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Store } from "../lib/store.mjs";
import { enforceJournalDailyLimit } from "../lib/journal-policy.mjs";

const at = "2026-10-21T03:00:00.000Z";
const noteBody = {
  encounter: "Synthetic encounter",
  missing: "Synthetic source only",
  evidence: [],
};
const code = (value) => (error) => error.code === value;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "humanism-journal-policy-"));
  const store = new Store(root);
  const reading = store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 7,
    duration: 60,
    route: "A1",
    segments: [],
    coverage: { state: "no_subtitles" },
  });
  return { root, store, reading };
}
function insertAt(store, readingId, stamp) {
  const id = store.note(readingId, noteBody);
  store.db.prepare("UPDATE notes SET created=? WHERE id=?").run(stamp, id);
  return id;
}

test("Shanghai dates, committed rows and legacy excess determine the daily allowance", () => {
  const { store, reading } = fixture();
  try {
    assert.throws(
      () => enforceJournalDailyLimit(store, at),
      code("JOURNAL_TRANSACTION_REQUIRED"),
    );
    store.tx(() => {
      const first = enforceJournalDailyLimit(store, "2026-10-20T15:59:59.999Z");
      assert.equal(first.date, "2026-10-20");
      assert.equal(first.remaining, 2);
      insertAt(store, reading.id, "2026-10-20T15:59:59.999Z");
      insertAt(store, reading.id, "2026-10-20T15:59:59.999Z");
      assert.throws(
        () => enforceJournalDailyLimit(store, "2026-10-20T15:59:59.999Z"),
        code("JOURNAL_DAILY_LIMIT"),
      );
      const next = enforceJournalDailyLimit(store, "2026-10-20T16:00:00.000Z");
      assert.equal(next.date, "2026-10-21");
      assert.equal(next.used, 0);
      // Existing historical excess remains intact and blocks further additions.
      for (let i = 0; i < 25; i++) insertAt(store, reading.id, at);
      assert.throws(
        () => enforceJournalDailyLimit(store, at),
        code("JOURNAL_DAILY_LIMIT"),
      );
      assert.equal(store.inbox().length, 27);
    });
  } finally {
    store.close();
  }
});

test("rollbacks do not spend allowance and restarts retain usage and risk controls", () => {
  const f = fixture();
  let store = f.store;
  try {
    store.setControl("pause", { reason: "Synthetic account risk" });
    store.setControl("synthetic-coin-budget", { spent: 2 });
    assert.throws(() =>
      store.tx(() => {
        enforceJournalDailyLimit(store, at);
        insertAt(store, f.reading.id, at);
        throw new Error("Synthetic later export failure");
      }),
    );
    assert.equal(store.inbox().length, 0);
    store.tx(() => {
      assert.equal(enforceJournalDailyLimit(store, at).used, 0);
      insertAt(store, f.reading.id, at);
    });
    store.close();
    store = new Store(f.root);
    store.tx(() => {
      assert.equal(enforceJournalDailyLimit(store, at).remaining, 1);
      insertAt(store, f.reading.id, at);
    });
    store.close();
    store = new Store(f.root);
    assert.throws(
      () => store.tx(() => enforceJournalDailyLimit(store, at)),
      code("JOURNAL_DAILY_LIMIT"),
    );
    assert.equal(store.getControl("pause").reason, "Synthetic account risk");
    assert.equal(store.getControl("synthetic-coin-budget").spent, 2);
    assert.throws(
      () => store.tx(() => enforceJournalDailyLimit(store, "invalid")),
      code("INVALID_JOURNAL_CLOCK"),
    );
  } finally {
    store.close();
  }
});

test(
  "two concurrent processes cannot both claim the last daily journal slot",
  { timeout: 15_000 },
  async () => {
    const { root, store, reading } = fixture();
    store.tx(() => insertAt(store, reading.id, at));
    const source = `
    import { Store } from ${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)};
    import { enforceJournalDailyLimit } from ${JSON.stringify(new URL("../lib/journal-policy.mjs", import.meta.url).href)};
    const store = new Store(process.argv[1]);
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      try {
        store.tx(() => {
          enforceJournalDailyLimit(store, ${JSON.stringify(at)});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
          const id = store.note(${JSON.stringify(reading.id)}, ${JSON.stringify(noteBody)});
          store.db.prepare("UPDATE notes SET created=? WHERE id=?").run(${JSON.stringify(at)}, id);
        });
        console.log("saved");
      } catch (e) { console.log(e.code || "unexpected"); }
      finally { store.close(); process.stdin.destroy(); }
    });
  `;
    const workers = [];
    try {
      for (let i = 0; i < 2; i++) {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", source, root],
          {
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          },
        );
        const lines = createInterface({ input: child.stdout });
        const ready = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error("Worker exited before readiness")),
          );
          lines.once("line", (line) =>
            line === "ready"
              ? resolve()
              : reject(new Error("Worker not ready")),
          );
        });
        const result = new Promise((resolve, reject) => {
          const output = [];
          lines.on("line", (line) => output.push(line));
          child.once("error", reject);
          child.once("exit", (status) =>
            status === 0
              ? resolve(output.at(-1))
              : reject(new Error("Worker failed")),
          );
        });
        workers.push({ child, ready, result });
      }
      await Promise.all(workers.map((w) => w.ready));
      for (const worker of workers) worker.child.stdin.end("go");
      const outcomes = await Promise.all(workers.map((w) => w.result));
      assert.deepEqual(outcomes.sort(), ["JOURNAL_DAILY_LIMIT", "saved"]);
      assert.equal(store.inbox().length, 2);
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill();
      store.close();
    }
  },
);
