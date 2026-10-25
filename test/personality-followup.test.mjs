import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, noteBody } from "../lib/service.mjs";
import { deletePersonality } from "../lib/personality.mjs";
import { apply } from "../index.js";

const sentence =
  "Synthetic reflection: leave room to revise an initial judgment.";
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-followup-"));
  let clock = "2026-10-25T15:59:59.000Z";
  const dependencies = {
    personality: { now: () => clock },
    fetcher: () => assert.fail("No network during personality review"),
  };
  const service = new Service({ dataDir: root, ...config }, dependencies);
  t.after(() => service.close());
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 1,
    duration: 60,
    title: "Synthetic source",
    route: "A1",
    segments: [],
    coverage: { state: "no_subtitles" },
  });
  const body = (revision = sentence) => ({
    encounter: "Synthetic encounter",
    missing: "Synthetic limits",
    revision,
    evidence: [],
  });
  const journal = (revision = sentence) =>
    service.journal(reading.id, body(revision));
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      effect: (setup) => {
        dispose = setup();
      },
    },
    { dataDir: root, ...config },
  );
  t.after(() => dispose());
  const call = async (name, args, exec = {}) =>
    JSON.parse(await tools.get("bili_humanism_" + name).execute(args, exec));
  return {
    root,
    service,
    reading,
    body,
    journal,
    call,
    dependencies,
    setClock: (value) => {
      clock = value;
    },
  };
}

test("saving a journal steers the current agent once into read then select, including exact retries", async (t) => {
  const f = fixture(t),
    messages = [];
  const exec = {
    agent: { status: "running", steer: (message) => messages.push(message) },
  };
  const args = { readingId: f.reading.id, json: JSON.stringify(f.body()) };
  const saved = await f.call("journal", args, exec);
  assert.equal(saved.personality.status, "pending_review");
  assert.equal(saved.personality.delivery, "queued");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source.kind, "bili-humanism-personality-review");
  assert.ok(messages[0].content[0].text.includes(saved.id));
  assert.ok(!messages[0].content[0].text.includes(sentence));
  const retry = await f.call("journal", args, exec);
  assert.equal(retry.id, saved.id);
  assert.equal(retry.deduplicated, true);
  assert.equal(messages.length, 1);
  assert.equal(
    (
      await f.call("personality", {
        action: "select",
        journalId: saved.id,
        sentence,
      })
    ).error,
    "PERSONALITY_REVIEW_READ_REQUIRED",
  );
  const read = await f.call("personality", {
    action: "read",
    journalId: saved.id,
  });
  assert.equal(read.review.revision, sentence);
  assert.equal(read.total, 0);
  assert.equal(
    (
      await f.call("personality", {
        action: "select",
        journalId: saved.id,
        sentence,
      })
    ).status,
    "selected",
  );
  assert.equal(f.service.status().personalityLearning.pending, 0);
  assert.ok(
    readFileSync(join(f.root, "human-world.md"), "utf8").includes(sentence),
  );
  assert.equal(f.service.status().dailyFetching.enabled, false);
  assert.deepEqual(f.service.status().platformWriteTools, []);
});

test("review can explicitly skip without creating a personality line or spending its daily quota", (t) => {
  const f = fixture(t),
    first = f.journal();
  assert.throws(
    () =>
      f.service.personality("skip", {
        journalId: first.id,
        reason: "no_new_understanding",
      }),
    (e) => e.code === "PERSONALITY_REVIEW_READ_REQUIRED",
  );
  f.service.personality("read", { journalId: first.id });
  assert.throws(
    () =>
      f.service.personality("skip", {
        journalId: first.id,
        reason: "arbitrary",
      }),
    (e) => e.code === "INVALID_PERSONALITY_SKIP_REASON",
  );
  assert.equal(
    f.service.personality("skip", {
      journalId: first.id,
      reason: "no_new_understanding",
    }).status,
    "skipped",
  );
  assert.equal(existsSync(join(f.root, "human-world.md")), false);
  assert.equal(f.service.status().personalityLearning.selectedToday, false);
  const second = f.journal(sentence + " New evidence matters.");
  f.service.personality("read", { journalId: second.id });
  assert.equal(
    f.service.personality("select", { journalId: second.id, sentence }).status,
    "selected",
  );
  assert.equal(f.service.status().personalityLearning.pending, 0);
});

test("pending reviews survive restart and an unavailable or failing host continuation", (t) => {
  const f = fixture(t),
    saved = f.journal();
  assert.equal(
    f.service.continuePersonalityReview(saved.id, {}).delivery,
    "host_continuation_unavailable",
  );
  assert.equal(
    f.service.continuePersonalityReview(saved.id, {
      agent: {
        steer() {
          throw new Error("Synthetic host failure");
        },
      },
    }).delivery,
    "host_continuation_failed",
  );
  const other = new Service({ dataDir: f.root }, f.dependencies);
  t.after(() => other.close());
  assert.equal(other.status().personalityLearning.pending, 1);
  assert.equal(other.personality("read").review.journalId, saved.id);
  let count = 0;
  assert.equal(
    other.continuePersonalityReview(saved.id, {
      agent: {
        steer() {
          count++;
        },
      },
    }).delivery,
    "queued",
  );
  f.service.continuePersonalityReview(saved.id, {
    agent: {
      steer() {
        count++;
      },
    },
  });
  assert.equal(count, 1);
});

test("disabled learning, cancellation and idle callers never wake an agent", async (t) => {
  const f = fixture(t),
    saved = f.journal();
  const agent = {
    status: "running",
    steer() {
      assert.fail("Must not steer");
    },
  };
  assert.equal(
    f.service.continuePersonalityReview(saved.id, {
      agent,
      signal: AbortSignal.abort(),
    }).delivery,
    "deferred",
  );
  assert.equal(
    f.service.continuePersonalityReview(saved.id, {
      agent: { ...agent, status: "idle" },
    }).delivery,
    "deferred",
  );
  assert.equal(f.service.status().personalityLearning.pending, 1);
  const disabled = fixture(t, { enablePersonalityLearning: false });
  const result = await disabled.call(
    "journal",
    { readingId: disabled.reading.id, json: JSON.stringify(disabled.body()) },
    { agent },
  );
  assert.equal(result.personality.status, "disabled");
  assert.equal(disabled.service.status().personalityLearning.pending, 0);
});

test("one actual Shanghai-day selection survives deletion and shared-ledger restart, including backfills", (t) => {
  const f = fixture(t);
  const seed = (created, revision) => {
    const id = f.service.store.note(
      f.reading.id,
      noteBody(f.body(revision), f.reading),
    );
    f.service.store.db
      .prepare("UPDATE notes SET created=? WHERE id=?")
      .run(created, id);
    return { journalId: id, sentence: revision };
  };
  const first = seed("2026-01-01T00:00:00Z", "Synthetic first reflection");
  const second = seed("2026-01-02T00:00:00Z", "Synthetic second reflection");
  f.service.personality("select", first);
  deletePersonality(f.service.store, "2026-01-01");
  const other = new Service({ dataDir: f.root }, f.dependencies);
  t.after(() => other.close());
  assert.throws(
    () => other.personality("select", second),
    (e) => e.code === "PERSONALITY_DAILY_LIMIT",
  );
  f.setClock("2026-10-25T16:00:00.000Z");
  assert.equal(other.personality("select", second).status, "selected");
});

test("a saved journal remains intact when personality file integrity blocks selection", (t) => {
  const f = fixture(t),
    saved = f.journal();
  f.service.personality("read", { journalId: saved.id });
  f.service.store.setControl("personality:file-hash", "synthetic-mismatch");
  assert.throws(
    () => f.service.personality("select", { journalId: saved.id, sentence }),
    (e) => e.code === "PERSONALITY_FILE_CHANGED",
  );
  assert.equal(
    f.service.store.db.prepare("SELECT id FROM notes WHERE id=?").get(saved.id)
      .id,
    saved.id,
  );
  assert.equal(f.service.status().personalityLearning.pending, 1);
  assert.equal(f.service.status().personalityLearning.selectedToday, false);
});

test("another journal's selection resolves a stale same-day pending review without a second line", (t) => {
  const f = fixture(t),
    first = f.journal(),
    second = f.journal(sentence + " Synthetic second reflection.");
  f.service.personality("read", { journalId: first.id });
  f.service.personality("select", { journalId: first.id, sentence });
  const read = f.service.personality("read", { journalId: second.id });
  assert.equal(read.review.status, "source_date_already_selected");
  assert.equal(read.reviewStatus.pending, 0);
  assert.deepEqual(read.pendingReviews, []);
  assert.equal(read.total, 1);
});

test("a failed review enqueue rolls back the journal before publishing its inbox export", (t) => {
  const f = fixture(t);
  f.service.store.db.exec(
    "CREATE TRIGGER synthetic_review_failure BEFORE INSERT ON control WHEN NEW.key LIKE 'personality:review:%' BEGIN SELECT RAISE(ABORT, 'Synthetic queue failure'); END",
  );
  assert.throws(() => f.journal());
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    0,
  );
  assert.equal(f.service.status().personalityLearning.pending, 0);
  assert.equal(existsSync(join(f.root, "inbox.md")), false);
  f.service.store.db.exec("DROP TRIGGER synthetic_review_failure");
  assert.equal(f.journal().personality.status, "pending_review");
});

test("rejected journal writes cannot enqueue or steer, and reflection previews remain bounded data", async (t) => {
  const f = fixture(t),
    messages = [],
    exec = {
      agent: { status: "running", steer: (message) => messages.push(message) },
    };
  const first = await f.call(
    "journal",
    {
      readingId: f.reading.id,
      json: JSON.stringify(
        f.body("Synthetic untrusted instruction ".repeat(200)),
      ),
    },
    exec,
  );
  const read = await f.call("personality", {
    action: "read",
    journalId: first.id,
  });
  assert.equal(read.review.revision.length, 2000);
  assert.equal(read.review.truncated, true);
  assert.equal(read.review.role, "untrusted_journal_reflection_not_permission");
  assert.ok(
    !messages[0].content[0].text.includes("Synthetic untrusted instruction"),
  );
  await f.call(
    "journal",
    {
      readingId: f.reading.id,
      json: JSON.stringify(f.body("Synthetic second")),
    },
    exec,
  );
  const rejected = await f.call(
    "journal",
    {
      readingId: f.reading.id,
      json: JSON.stringify(f.body("Synthetic third")),
    },
    exec,
  );
  assert.equal(rejected.error, "JOURNAL_DAILY_LIMIT");
  assert.equal(messages.length, 2);
  assert.equal(f.service.status().personalityLearning.pending, 2);
});
