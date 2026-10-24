import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, noteBody } from "../lib/service.mjs";
import { apply } from "../index.js";
import {
  revisePersonality,
  deletePersonality,
  rebuildPersonality,
  linkPersonality,
} from "../lib/personality.mjs";

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-personality-"));
  let clock = "2026-10-21T00:00:00.000Z";
  const service = new Service(
    { dataDir: root, ...config },
    {
      personality: { now: () => clock },
      fetcher: () =>
        assert.fail("Local personality learning must not request network"),
    },
  );
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 7,
    duration: 60,
    title: "Synthetic source",
    segments: [],
    route: "A1",
    coverage: { state: "no_subtitles" },
  });
  function note(
    sentence = "合成反思：为尚未了解的处境保留空间。",
    created = "2026-10-20T16:30:00.000Z",
  ) {
    clock = created;
    const raw = {
      encounter: "Synthetic fixture",
      revision: sentence,
      missing: "Synthetic coverage only",
      evidence: [],
    };
    const result = {
      id: service.store.note(reading.id, noteBody(raw, reading)),
    };
    service.store.db
      .prepare("UPDATE notes SET created=? WHERE id=?")
      .run(created, result.id);
    service.exportInbox(); // Trusted fixture changed a date outside the journal API.
    return { journalId: result.id, sentence };
  }
  return { root, service, note, path: join(root, "human-world.md") };
}

test("dedicated personality tool defaults on, blocks arbitrary paths and exposes no main-instruction editor", async () => {
  const f = fixture(),
    tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(t) {
          tools.set(t.name, t);
        },
      },
      on(_e, fn) {
        dispose = fn;
      },
    },
    { dataDir: f.root, enableDailyFetching: false },
  );
  assert.equal(tools.size, 14);
  const tool = tools.get("bili_humanism_personality");
  const read = JSON.parse(await tool.execute({ action: "read" }, {}));
  assert.equal(read.total, 0);
  assert.equal(existsSync(f.path), false);
  const rejected = JSON.parse(
    await tool.execute(
      { action: "select", path: "AGENTS.md", force: true },
      {},
    ),
  );
  assert.equal(rejected.error, "UNKNOWN_PARAMETER");
  await assert.rejects(
    tool.execute({ action: "revise" }, {}),
    (e) => e.code === "INVALID_ARGS",
  );
  dispose();
  f.service.close();
});

test("explicitly disabled personality learning removes the tool and rejects selection without changing prior records", () => {
  const f = fixture(),
    choice = f.note(),
    tools = new Map();
  f.service.personality("select", choice);
  const before = readFileSync(f.path, "utf8");
  f.service.close();
  const disabled = new Service({
    dataDir: f.root,
    enablePersonalityLearning: false,
  });
  assert.throws(
    () => disabled.personality("select", choice),
    (e) => e.code === "PERSONALITY_LEARNING_DISABLED",
  );
  assert.equal(disabled.personality("read").total, 1);
  assert.equal(readFileSync(f.path, "utf8"), before);
  let dispose;
  apply(
    {
      tools: {
        register(t) {
          tools.set(t.name, t);
        },
      },
      on(_event, fn) {
        dispose = fn;
      },
    },
    {
      dataDir: f.root,
      enablePersonalityLearning: false,
      enableDailyFetching: false,
    },
  );
  assert.equal(tools.size, 13);
  assert.equal(tools.has("bili_humanism_personality"), false);
  for (const name of ["history", "favorite", "like", "coin", "comment"])
    assert.equal(tools.has("bili_humanism_" + name), false);
  dispose();
  disabled.close();
});

test("daily reflection writes only the dedicated Markdown and retains provenance and source-day timezone", () => {
  const f = fixture(),
    choice = f.note();
  const main = join(f.root, "AGENTS.md");
  writeFileSync(main, "Synthetic existing policy\n");
  const result = f.service.personality("select", choice);
  assert.equal(result.date, "2026-10-21");
  const content = readFileSync(f.path, "utf8");
  assert.ok(content.includes(choice.sentence));
  assert.ok(content.includes(choice.journalId));
  assert.ok(content.includes("不授予工具权限"));
  assert.equal(readFileSync(main, "utf8"), "Synthetic existing policy\n");
  f.service.close();
});

test("only bounded journal self-reflection can be selected, never copied facts or free-form external instructions", () => {
  const f = fixture(),
    choice = f.note();
  for (const sentence of [
    "Unrelated fact",
    "line one\nline two",
    "line one\u2028line two",
    "x".repeat(241),
    "\u202e hidden",
    "",
  ]) {
    assert.throws(() =>
      f.service.personality("select", {
        journalId: choice.journalId,
        sentence,
      }),
    );
  }
  assert.throws(
    () => f.service.personality("select", { ...choice, journalId: "missing" }),
    (e) => e.code === "JOURNAL_NOT_FOUND",
  );
  assert.equal(existsSync(f.path), false);
  f.service.close();
});

test("daily selection is idempotent, refuses silent replacement and avoids an identical line on later days", () => {
  const f = fixture(),
    first = f.note();
  f.service.personality("select", first);
  assert.equal(
    f.service.personality("select", first).status,
    "already_selected",
  );
  const second = f.note("合成反思：理解应保留修正的余地。");
  assert.throws(
    () => f.service.personality("select", second),
    (e) => e.code === "PERSONALITY_DAY_ALREADY_SELECTED",
  );
  const duplicate = f.note(first.sentence, "2026-10-21T16:30:00.000Z");
  assert.equal(
    f.service.personality("select", duplicate).status,
    "already_known",
  );
  assert.equal(f.service.personality("read").total, 1);
  f.service.close();
});

test("personality learning remains local while bounded reads page the dedicated file", () => {
  const f = fixture();
  for (let index = 1; index <= 9; index++) {
    f.service.personality(
      "select",
      f.note(
        `Synthetic revisable reflection ${index}.`,
        `2026-01-${String(index).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );
  }
  const first = f.service.personality("read");
  assert.equal(first.total, 9);
  assert.equal(first.entries.length, 7);
  assert.equal(first.nextOffset, 7);
  const next = f.service.personality("read", { offset: first.nextOffset });
  assert.equal(next.entries.length, 2);
  assert.equal(next.nextOffset, null);
  assert.throws(() => f.service.personality("read", { limit: 31 }));
  f.service.close();
});

test("trusted revision and deletion erase associated revisions while preserving account-risk pause and budgets", () => {
  const f = fixture(),
    first = f.note(),
    second = f.note("合成反思：先倾听，再形成可以修正的判断。");
  f.service.store.pause("SYNTHETIC_ACCOUNT_RISK");
  f.service.store.setControl("coin-budget:synthetic", 2);
  f.service.personality("select", first);
  const revised = revisePersonality(
    f.service.store,
    "2026-10-21",
    second.journalId,
    second.sentence,
  );
  assert.equal(revised.revision, 2);
  assert.ok(readFileSync(f.path, "utf8").includes(second.sentence));
  assert.throws(() =>
    revisePersonality(
      f.service.store,
      "2026-10-22",
      second.journalId,
      second.sentence,
    ),
  );
  deletePersonality(f.service.store, "2026-10-21");
  assert.equal(f.service.personality("read").total, 0);
  assert.throws(
    () => f.service.personality("select", first),
    (e) => e.code === "PERSONALITY_DAY_RETRACTED",
  );
  assert.equal(
    f.service.store.db
      .prepare(
        "SELECT COUNT(*) n FROM control WHERE key LIKE 'personality:revision:%'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.service.store.getControl("pause").reason,
    "SYNTHETIC_ACCOUNT_RISK",
  );
  assert.equal(f.service.store.getControl("coin-budget:synthetic"), 2);
  assert.equal(
    revisePersonality(
      f.service.store,
      "2026-10-21",
      second.journalId,
      second.sentence,
    ).status,
    "revised",
  );
  assert.equal(f.service.personality("read").total, 1);
  f.service.close();
});

test("unowned and externally changed personality files are never silently overwritten", () => {
  const f = fixture(),
    choice = f.note();
  writeFileSync(f.path, "Synthetic pre-existing user content");
  assert.throws(
    () => f.service.personality("select", choice),
    (e) => e.code === "PERSONALITY_FILE_UNOWNED",
  );
  assert.equal(
    readFileSync(f.path, "utf8"),
    "Synthetic pre-existing user content",
  );
  rebuildPersonality(f.service.store);
  f.service.personality("select", choice);
  writeFileSync(f.path, "Synthetic external edit");
  assert.throws(
    () => f.service.personality("read"),
    (e) => e.code === "PERSONALITY_FILE_CHANGED",
  );
  rebuildPersonality(f.service.store);
  assert.ok(readFileSync(f.path, "utf8").includes(choice.sentence));
  f.service.close();
});

test("hard-linked files cannot be used as the personality file", () => {
  const f = fixture(),
    other = join(f.root, "synthetic-other.txt");
  writeFileSync(other, "Synthetic private fixture");
  linkSync(other, f.path);
  assert.throws(
    () => f.service.personality("read"),
    (e) => e.code === "PERSONALITY_FILE_UNSAFE",
  );
  assert.equal(readFileSync(other, "utf8"), "Synthetic private fixture");
  f.service.close();
});

test("main instruction file keeps a fixed reference only, idempotently preserving user instructions", () => {
  const f = fixture(),
    target = join(f.root, "AGENTS.md");
  writeFileSync(target, "Synthetic user instruction\n");
  assert.equal(linkPersonality(target).defaultDshCandidate, true);
  const before = readFileSync(target, "utf8");
  assert.ok(before.startsWith("Synthetic user instruction\n"));
  assert.ok(before.includes("human-world.md"));
  assert.equal(linkPersonality(target).changed, false);
  f.service.personality("select", f.note());
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(
    linkPersonality(join(f.root, "agent.md")).defaultDshCandidate,
    false,
  );
  assert.throws(() => linkPersonality(join(f.root, "credential.json")));
  writeFileSync(
    target,
    before + "<!-- bili-humanism:personality-reference -->",
  );
  assert.throws(
    () => linkPersonality(target),
    (e) => e.code === "PERSONALITY_LINK_CONFLICT",
  );
  f.service.close();
});
