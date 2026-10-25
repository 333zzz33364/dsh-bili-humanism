import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { digest } from "../lib/store.mjs";
import { fields } from "../lib/inbox.mjs";
import { apply } from "../index.js";

const body = (text = "Synthetic reflection") => ({
  ...Object.fromEntries(fields.map((k) => [k, ""])),
  encounter: text,
  missing: "Synthetic source only",
  evidence: [],
});
function fixture(n = 0) {
  const root = mkdtempSync(join(tmpdir(), "humanism-inbox-"));
  const service = new Service({ dataDir: root });
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 7,
    duration: 60,
    title: "Synthetic title",
    author: "Synthetic author",
    url: "https://www.bilibili.com/video/BV0000000001/?p=1",
    route: "A1",
    segments: [],
    coverage: { state: "no_subtitles" },
  });
  service.store.tx(() => {
    for (let i = 0; i < n; i++) {
      const id = service.store.note(reading.id, body("Synthetic record " + i));
      service.store.db
        .prepare("UPDATE notes SET created=? WHERE id=?")
        .run(
          i < n / 2 ? "2026-01-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z",
          id,
        );
    }
  });
  return { service, root, reading };
}
const code = (expected) => (e) => e.code === expected;

test("public journal tool deduplicates retries and shares a durable two-entry daily limit with the service", async () => {
  const f = fixture();
  f.service.close();
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(t) {
          tools.set(t.name, t);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir: f.root, enableDailyFetching: false },
  );
  const tool = tools.get("bili_humanism_journal");
  const save = async (note) =>
    JSON.parse(
      await tool.execute(
        { readingId: f.reading.id, json: JSON.stringify(note) },
        {},
      ),
    );
  try {
    const first = await save(body("First synthetic encounter"));
    const retry = await save({
      ...body("First synthetic encounter"),
      encounter: "  First synthetic encounter  ",
    });
    assert.equal(first.id, retry.id);
    assert.equal(retry.deduplicated, true);
    assert.ok((await save(body("Second synthetic encounter"))).id);
    assert.equal(
      (await save(body("Third synthetic encounter"))).error,
      "JOURNAL_DAILY_LIMIT",
    );
    assert.equal((await save(body("First synthetic encounter"))).id, first.id);
    const status = JSON.parse(
      await tools.get("bili_humanism_status").execute({}, {}),
    );
    assert.equal(status.journals.remaining, 0);
    assert.equal(status.journals.used, 2);
    assert.equal(
      JSON.parse(
        await tool.execute(
          {
            readingId: f.reading.id,
            json: JSON.stringify(body()),
            force: true,
          },
          {},
        ),
      ).error,
      "UNKNOWN_PARAMETER",
    );
  } finally {
    dispose();
  }
  const restarted = new Service({ dataDir: f.root });
  try {
    assert.equal(restarted.store.inbox().length, 2);
    assert.throws(
      () => restarted.journal(f.reading.id, body("After restart")),
      code("JOURNAL_DAILY_LIMIT"),
    );
  } finally {
    restarted.close();
  }
});

test("empty inbox is complete and legacy previews migrate from the full ledger", () => {
  const empty = fixture();
  try {
    assert.deepEqual(empty.service.inbox(), []);
    const index = empty.service.inbox({ action: "index" });
    assert.equal(index.total, 0);
    assert.equal(index.nextVolume, null);
  } finally {
    empty.service.close();
  }
  const old = fixture(125);
  try {
    writeFileSync(join(old.root, "inbox.md"), "Synthetic old partial preview");
    assert.equal(old.service.inbox({ action: "index" }).total, 125);
    assert.ok(
      !readFileSync(join(old.root, "inbox.md"), "utf8").includes(
        "old partial preview",
      ),
    );
  } finally {
    old.service.close();
  }
});

test("export links and untrusted index edits cannot conceal missing or altered text", () => {
  const { service: s, root } = fixture(1);
  try {
    s.exportInbox();
    const path = join(root, "inbox.md");
    linkSync(path, join(root, "linked-copy.md"));
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_FILE_UNSAFE"),
    );
    s.exportInbox();
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Synthetic record", "Altered record"),
    );
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_FULL_CHANGED"),
    );
    s.exportInbox();
    writeFileSync(join(root, "inbox-index.json"), "{}");
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_INDEX_CHANGED"),
    );
  } finally {
    s.close();
  }
});

test("complete ledger export exceeds 100 journals; monthly volumes reconcile every ID", () => {
  const { service: s, root } = fixture(125);
  try {
    s.store.setControl("pause", { reason: "test pause" });
    s.store.setControl("coin-budget", { spent: 2 });
    s.exportInbox();
    const index = s.inbox({ action: "index" });
    assert.equal(index.total, 125);
    assert.deepEqual(index.checks, {
      fullEqualsIndex: true,
      volumeSumEqualsIndex: true,
    });
    assert.throws(() => s.inbox(), code("INBOX_PAGINATION_REQUIRED"));
    const ids = [],
      sections = new Set();
    let volume = index.nextVolume;
    while (volume !== null) {
      const page = s.inbox({
        action: "volume",
        volume,
        snapshot: index.snapshot,
      });
      sections.add(page.section);
      ids.push(...page.fragments.filter((p) => p.part === 1).map((p) => p.id));
      assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 60 * 1024);
      assert.ok(Buffer.byteLength(page.text) <= 24 * 1024);
      assert.ok(page.text.split("\n").length <= 350);
      volume = page.nextVolume;
    }
    assert.equal(new Set(ids).size, 125);
    assert.deepEqual(new Set(ids), new Set(s.store.inbox().map((r) => r.id)));
    assert.deepEqual([...sections], ["2026-01", "2026-02"]);
    assert.equal(
      (
        readFileSync(join(root, "inbox.md"), "utf8").match(
          /^<!-- journal:/gm,
        ) || []
      ).length,
      125,
    );
    assert.equal(s.store.getControl("pause").reason, "test pause");
    assert.equal(s.store.getControl("coin-budget").spent, 2);
    const all = s.store.inbox.bind(s.store);
    s.store.inbox = () => all().slice(0, 100);
    assert.throws(() => s.exportInbox(), code("INBOX_FULL_INDEX_MISMATCH"));
    s.store.inbox = all;
  } finally {
    s.close();
  }
});

test("one journal larger than reported byte and line limits splits without losing its tail", () => {
  const { service: s, reading, root } = fixture();
  try {
    const note = {
      ...body(),
      encounter: "合成材料\n".repeat(1800),
      revision: '中文😀"\\'.repeat(1800) + "TAIL_REVISION",
      missing: "合成限制\n".repeat(1800),
      next_response: "合成回应\n".repeat(1800) + "TAIL_RESPONSE",
    };
    const saved = s.journal(reading.id, note),
      index = s.inbox({ action: "index" });
    assert.ok(
      Buffer.byteLength(readFileSync(join(root, "inbox.md"))) > 90 * 1024,
    );
    assert.ok(
      readFileSync(join(root, "inbox.md"), "utf8").split("\n").length > 950,
    );
    assert.equal(index.total, 1);
    let count = 0,
      combined = "";
    for (let volume = 0; volume < index.volumeCount; volume++) {
      const page = s.inbox({
        action: "volume",
        volume,
        snapshot: index.snapshot,
      });
      assert.ok(page.fragments.every((p) => p.id === saved.id));
      count += page.count;
      combined += page.text;
      assert.ok(!page.text.includes("\ufffd"));
      assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 60 * 1024);
    }
    assert.equal(count, 1);
    assert.ok(
      combined.includes("TAIL_REVISION") && combined.includes("TAIL_RESPONSE"),
    );
    assert.throws(() => s.inbox(), code("INBOX_PAGINATION_REQUIRED"));
    s.journal(
      reading.id,
      body(
        "Synthetic escaped text " + "\u0000".repeat(11000) + " ESCAPED_TAIL",
      ),
    );
    const escapedIndex = s.inbox({ action: "index" });
    let tail = false;
    for (let volume = 0; volume < escapedIndex.volumeCount; volume++) {
      const page = s.inbox({
        action: "volume",
        volume,
        snapshot: escapedIndex.snapshot,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2)) <= 60 * 1024);
      tail ||= page.text.includes("ESCAPED_TAIL");
    }
    assert.equal(tail, true);
  } finally {
    s.close();
  }
});

test("truncation, missing files and same-count substitutions fail explicitly; trusted rebuild repairs", () => {
  const { service: s, root, reading } = fixture(3);
  try {
    s.exportInbox();
    const fullPath = join(root, "inbox.md"),
      full = readFileSync(fullPath, "utf8");
    writeFileSync(fullPath, full.replace(/^<!-- journal:.* -->\n/m, ""));
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_FULL_INDEX_MISMATCH"),
    );
    assert.throws(
      () => s.journal(reading.id, body()),
      code("INBOX_FULL_INDEX_MISMATCH"),
    );
    assert.equal(s.store.inbox().length, 3);
    s.exportInbox();
    const path = join(root, "inbox-index.json"),
      manifest = JSON.parse(readFileSync(path, "utf8"));
    const volumePath = join(root, "inbox-parts", manifest.volumes[0].name);
    const text = readFileSync(volumePath, "utf8");
    writeFileSync(volumePath, text.replace(/^<!-- journal:.* -->\n/m, ""));
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_VOLUME_INDEX_MISMATCH"),
    );
    s.exportInbox();
    unlinkSync(volumePath);
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_EXPORT_MISSING"),
    );
    s.exportInbox();
    // Simulate a generator error that duplicates an ID while keeping the count.
    const altered = JSON.parse(readFileSync(path, "utf8"));
    altered.records[1].id = altered.records[0].id;
    const json = JSON.stringify(altered, null, 2);
    writeFileSync(path, json);
    s.store.setControl("inbox:index-hash", digest(json));
    assert.throws(
      () => s.inbox({ action: "index" }),
      code("INBOX_FULL_INDEX_MISMATCH"),
    );
    s.exportInbox();
    assert.equal(s.inbox({ action: "index" }).total, 3);
  } finally {
    s.close();
  }
});

test("registered tool keeps small inbox arrays and requires stable snapshots for volume traversal", async () => {
  const { service: s, root, reading } = fixture(1);
  s.exportInbox();
  s.close();
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(t) {
          tools.set(t.name, t);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir: root, enableDailyFetching: false },
  );
  try {
    const tool = tools.get("bili_humanism_inbox");
    const call = async (a) => JSON.parse(await tool.execute(a, {}));
    assert.equal((await call({})).length, 1);
    const index = await call({ action: "index" });
    assert.equal(
      (await call({ action: "volume", volume: 0 })).error,
      "INVALID_INBOX_PAGE",
    );
    assert.equal(
      (await call({ action: "volume", volume: 0, snapshot: index.snapshot }))
        .count,
      1,
    );
    const writer = new Service({ dataDir: root });
    writer.journal(reading.id, body());
    writer.close();
    assert.equal(
      (await call({ action: "volume", volume: 0, snapshot: index.snapshot }))
        .error,
      "INBOX_SNAPSHOT_CHANGED",
    );
    assert.equal(
      (
        await call({
          action: "volume",
          volume: -1,
          snapshot: (await call({ action: "index" })).snapshot,
        })
      ).error,
      "INVALID_INBOX_PAGE",
    );
  } finally {
    dispose();
  }
});
