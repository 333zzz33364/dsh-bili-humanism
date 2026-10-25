import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { attachPersonalityShadow } from "../lib/personality-shadow-host.mjs";
import { apply } from "../index.js";
import { revisePersonality, deletePersonality } from "../lib/personality.mjs";

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-shadow-"));
  let clock = Date.parse("2026-10-25T10:00:00Z"),
    seq = 0;
  const service = new Service(
    { dataDir: root, enablePersonalityShadow: true, ...config },
    {
      shadow: { now: () => clock },
      personality: { now: () => new Date(clock).toISOString() },
      fetcher: () => assert.fail("No platform traffic"),
    },
  );
  const shadow = service.shadow;
  function emit(sessionId, text, role = "user", extra = {}) {
    const message = {
      id: `message-${++seq}`,
      role,
      source: { kind: role === "user" ? "user" : "model" },
      content: [{ type: "text", text }],
      ...extra,
    };
    const event = {
      seq,
      time: clock,
      type: role === "user" ? "user/message" : "assistant/message",
      data: role === "user" ? message : { message },
    };
    shadow.observe(
      { header: { id: sessionId }, inheritedEventCount: 0 },
      event,
    );
    return { message, event };
  }
  const exec = (id) => ({
    agent: { id },
    signal: new AbortController().signal,
  });
  const read = (id) => shadow.tool({ action: "read" }, exec(id));
  return {
    root,
    service,
    shadow,
    emit,
    exec,
    read,
    nextDay: () => {
      clock += 86400000;
    },
  };
}
function proposal(snapshot) {
  const humans = snapshot.episodes
    .flatMap((e) => e.evidence)
    .filter((e) => e.role === "user" && e.text);
  return {
    kind: "affective_orientation",
    observation: "两次合成对话中都提到想先分享。",
    possibleMeaning: "这次对方可能希望有人共同感受，而不急于解决问题。",
    alternativeMeaning: "也可能只是暂时没有空处理方案。",
    agentMiss: "agent 太快把分享转为待办。",
    conditionalResponse:
      "在分享而非求解时，先回应其珍视的细节，再询问是否需要建议。",
    appliesWhen: "用户正在分享生活片段且没有明确求解要求时。",
    counterexample: "用户明确要方案或处于紧急处理任务时，应直接协助。",
    uncertainty: "合成片段有限，不能推断稳定人格。",
    evidence: humans
      .slice(0, 2)
      .map((m) => ({ messageId: m.messageId, quote: m.text.slice(0, 40) })),
  };
}
test("shadow is opt-in, personality disable overrides it, baseline tools unchanged", () => {
  for (const cfg of [
    { enablePersonalityShadow: false },
    { enablePersonalityLearning: false },
  ]) {
    const f = fixture(cfg),
      hooks = [];
    attachPersonalityShadow({ on: (...a) => hooks.push(a) }, f.shadow);
    f.emit("a", "Synthetic text");
    assert.equal(f.shadow.status().enabled, false);
    assert.equal(hooks.length, 0);
    assert.equal(
      f.service.store.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='shadow_messages'",
        )
        .get().n,
      0,
    );
    assert.throws(() => f.read("a"), { code: "SHADOW_DISABLED" });
    f.service.close();
  }
});
test("organizer uses visible human ingress, links preceding response and next response; ignores tools, synthetic steering, subagents and inherited prefix", () => {
  const f = fixture();
  f.emit("a", "Synthetic prior assistant", "assistant");
  const human = f.emit("a", "我只是想分享这件小事。");
  f.emit("a", "谢谢你把这个细节告诉我。", "assistant");
  f.emit("a", "", "assistant", {
    content: [
      {
        type: "tool-call",
        id: "synthetic-call",
        name: "synthetic",
        arguments: "{}",
      },
    ],
  });
  f.emit("a", "Synthetic injected notice", "user", {
    source: { kind: "agent-instructions" },
  });
  f.shadow.observe(
    { header: { id: "child", origin: "subagent" } },
    human.event,
  );
  f.shadow.observe(
    { header: { id: "fork" }, inheritedEventCount: 999 },
    human.event,
  );
  f.shadow.observe(
    { header: { id: "a" } },
    {
      seq: 20,
      time: Date.now(),
      type: "tool/result",
      data: { content: "never collect" },
    },
  );
  const s = f.read("a");
  assert.equal(s.episodes.length, 1);
  assert.deepEqual(
    s.episodes[0].evidence.map((m) => m.role),
    ["assistant", "user", "assistant"],
  );
  assert.equal(s.episodes[0].evidence[1].messageId, human.message.id);
  assert.equal(f.shadow.status().episodes, 1);
  f.service.close();
});
test("two independent sessions produce grounded shadow candidate, never journal, formal memory or selected-day quota", () => {
  const f = fixture();
  f.emit("a", "我只是想分享今天路边的一朵小花。");
  f.emit("a", "Synthetic acknowledgement", "assistant");
  f.emit("b", "不用急着给建议，我想先分享这一刻。");
  const s = f.read("b"),
    p = proposal(s);
  const before = f.service.store.db
    .prepare("SELECT count(*) n FROM control WHERE key LIKE 'personality:%'")
    .get().n;
  const result = f.shadow.tool(
    { action: "propose", snapshotId: s.snapshotId, json: JSON.stringify(p) },
    f.exec("b"),
  );
  assert.equal(result.crossSession, true);
  assert.equal(result.active, false);
  assert.equal(result.humanValidated, false);
  const inspected = f.shadow.inspect();
  assert.equal(inspected.candidatesPage[0].crossSession, true);
  assert.equal(
    inspected.candidatesPage[0].body.possibleMeaning,
    p.possibleMeaning,
  );
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    0,
  );
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM memory").get().n,
    0,
  );
  assert.equal(
    f.service.store.db
      .prepare("SELECT count(*) n FROM control WHERE key LIKE 'personality:%'")
      .get().n,
    before,
  );
  assert.equal(existsSync(join(f.root, "human-world.md")), false);
  assert.throws(
    () =>
      f.service.personality("select", {
        journalId: result.id,
        sentence: p.conditionalResponse,
      }),
    { code: "JOURNAL_NOT_FOUND" },
  );
  assert.equal(
    f.shadow.tool(
      { action: "propose", snapshotId: s.snapshotId, json: JSON.stringify(p) },
      f.exec("b"),
    ).deduplicated,
    true,
  );
  f.service.close();
});
test("proposals require exact owned read evidence and current human quote; identity, paths, force and promotion are rejected", () => {
  const f = fixture();
  f.emit("a", "Synthetic human meaning.");
  f.emit("b", "Synthetic unrelated context.");
  const s = f.read("a"),
    p = proposal(s);
  const submit = (data = p, owner = "a", more = {}) =>
    f.shadow.tool(
      {
        action: "propose",
        snapshotId: s.snapshotId,
        json: JSON.stringify(data),
        ...more,
      },
      f.exec(owner),
    );
  assert.throws(() => submit(p, "b"), { code: "SHADOW_READ_REQUIRED" });
  assert.throws(() => submit({ ...p, userTrait: "dependent" }), {
    code: "SHADOW_INVALID_FIELDS",
  });
  assert.throws(
    () =>
      submit({
        ...p,
        evidence: [{ messageId: "foreign", quote: "Invented quote" }],
      }),
    { code: "SHADOW_EVIDENCE_MISMATCH" },
  );
  assert.throws(() => submit({ ...p, evidence: [p.evidence[1]] }), {
    code: "SHADOW_ANCHOR_HUMAN_EVIDENCE_REQUIRED",
  });
  assert.throws(() => submit(p, "a", { force: true }), {
    code: "SHADOW_INVALID_FIELDS",
  });
  assert.throws(
    () =>
      f.shadow.tool(
        { action: "promote", snapshotId: s.snapshotId },
        f.exec("a"),
      ),
    { code: "SHADOW_INVALID_ACTION" },
  );
  assert.throws(
    () => f.shadow.tool({ action: "read", path: "outside.md" }, f.exec("a")),
    { code: "SHADOW_INVALID_FIELDS" },
  );
  assert.throws(() => f.shadow.tool({ action: "read" }, {}), {
    code: "SHADOW_HOST_AGENT_REQUIRED",
  });
  f.service.close();
});
test("engineering-only and insufficient-context skips are durable, idempotent, no candidate pressure", () => {
  const f = fixture();
  for (const reason of ["engineering_only", "insufficient_context"]) {
    f.emit(reason, "Synthetic fixture; do not infer an emotion.");
    const s = f.read(reason),
      args = { action: "skip", snapshotId: s.snapshotId, reason };
    assert.equal(f.shadow.tool(args, f.exec(reason)).status, "skipped");
    assert.equal(f.shadow.tool(args, f.exec(reason)).deduplicated, true);
    assert.equal(f.read(reason).pending, false);
  }
  assert.equal(f.shadow.status().candidates, 0);
  assert.equal(f.shadow.status().pending, 0);
  f.service.close();
});
test("collection deduplicates restores, reports ID conflicts, excludes credentials and oversized text explicitly", () => {
  const f = fixture();
  const { event } = f.emit(
    "a",
    "Synthetic https://example.invalid/?secret=withheld value",
  );
  f.shadow.observe({ header: { id: "a" } }, event);
  f.shadow.observe({ header: { id: "fork" } }, event);
  assert.equal(f.shadow.status().episodes, 1);
  assert.equal(
    f.read("a").episodes[0].evidence[0].text,
    "Synthetic [URL withheld] value",
  );
  f.shadow.observe(
    { header: { id: "a" } },
    {
      ...event,
      data: { ...event.data, content: [{ type: "text", text: "changed" }] },
    },
  );
  assert.ok(
    f.shadow
      .status()
      .diagnostics.some((d) => d.code === "SHADOW_MESSAGE_ID_CONFLICT"),
  );
  f.emit("c", "Authorization: Bearer SYNTHETIC_NOT_A_CREDENTIAL");
  f.emit("d", "文".repeat(2100));
  assert.equal(f.read("c").pending, false);
  assert.equal(f.read("d").pending, false);
  const stored = f.service.store.db
    .prepare("SELECT body FROM shadow_messages")
    .all()
    .map((r) => r.body)
    .join();
  assert.ok(!stored.includes("SYNTHETIC_NOT_A_CREDENTIAL"));
  assert.ok(!stored.includes("文".repeat(2100)));
  f.service.close();
});
test("cross-session read is bounded to current plus five, candidates never returned to model, cancellation does not change queue", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.emit("s" + i, "Synthetic " + i);
  const s = f.read("s11");
  assert.equal(s.episodes.length, 6);
  assert.equal(s.contextComplete, false);
  const signal = AbortSignal.abort();
  assert.throws(
    () =>
      f.shadow.tool(
        {
          action: "skip",
          snapshotId: s.snapshotId,
          reason: "insufficient_context",
        },
        { agent: { id: "s11" }, signal },
      ),
    { code: "CANCELLED" },
  );
  assert.equal(f.shadow.status().pending, 12);
  assert.equal(JSON.stringify(s).includes("candidatesPage"), false);
  f.service.close();
});
test("bounded stop-boundary continuation once per turn and day, no idle/cancel wake, source never in steering; failed delivery keeps pending", () => {
  const f = fixture(),
    steering = [];
  f.emit("a", "Synthetic private prose never copied into steering.");
  const payload = {
    agent: { id: "a", status: "running", steer: (m) => steering.push(m) },
    signal: new AbortController().signal,
    turn: 1,
  };
  f.shadow.continue({
    ...payload,
    agent: { ...payload.agent, status: "idle" },
  });
  f.shadow.continue({ ...payload, signal: AbortSignal.abort() });
  assert.equal(steering.length, 0);
  f.shadow.continue(payload);
  f.shadow.continue(payload);
  assert.equal(steering.length, 1);
  assert.ok(!JSON.stringify(steering).includes("Synthetic private prose"));
  f.emit("a", "Synthetic second episode");
  f.shadow.continue({ ...payload, turn: 2 });
  f.emit("a", "Synthetic third episode");
  f.shadow.continue({ ...payload, turn: 3 });
  assert.equal(steering.length, 2);
  f.nextDay();
  f.shadow.continue({
    ...payload,
    turn: 4,
    agent: {
      ...payload.agent,
      steer: () => {
        throw Error("Synthetic admission failure");
      },
    },
  });
  assert.equal(f.shadow.status().pending, 3);
  assert.ok(
    f.shadow
      .status()
      .diagnostics.some((d) => d.code === "SHADOW_CONTINUATION_UNAVAILABLE"),
  );
  f.service.close();
});
test("host guard isolates shadow review, excludes recursive review output, releases existing tools at turn end", () => {
  const f = fixture(),
    hooks = new Map();
  let guard;
  attachPersonalityShadow(
    {
      on: (name, fn) => hooks.set(name, fn),
      effect: (setup) => hooks.set("dispose", setup()),
      tools: {
        guard: (fn) => {
          guard = fn;
        },
      },
    },
    f.shadow,
  );
  f.emit("a", "Synthetic source");
  f.emit("a", "Synthetic own review", "user", {
    source: { kind: "bili-humanism-shadow-review" },
  });
  f.emit("a", "Synthetic proposed interpretation", "assistant");
  assert.equal(
    guard({ agent: { id: "a" }, name: "bili_humanism_memory" }),
    "SHADOW_REVIEW_TOOLS_ONLY",
  );
  assert.equal(
    guard({ agent: { id: "a" }, name: "bili_humanism_shadow" }),
    undefined,
  );
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM shadow_messages").get()
      .n,
    1,
  );
  f.shadow.continue({
    agent: { id: "a", status: "running", steer: () => assert.fail() },
    turn: 1,
  });
  assert.equal(
    guard({ agent: { id: "a" }, name: "bili_humanism_journal" }),
    undefined,
  );
  hooks.get("dispose")();
  f.emit("a", "Synthetic after dispose");
  assert.equal(f.shadow.status().episodes, 1);
  f.service.close();
});
test("reopen preserves evidence and candidates, trusted erasure leaves formal data and delivery quotas intact", () => {
  const f = fixture();
  f.emit("a", "Synthetic editable local evidence");
  const s = f.read("a");
  f.shadow.tool(
    {
      action: "propose",
      snapshotId: s.snapshotId,
      json: JSON.stringify(proposal(s)),
    },
    f.exec("a"),
  );
  f.service.store.setControl("personality:synthetic-preserve", {
    value: "keep",
  });
  f.service.store.setControl("shadow:delivery-day:2026-10-25", 2);
  f.service.close();
  const reopened = new Service({
    dataDir: f.root,
    enablePersonalityShadow: true,
  });
  assert.equal(reopened.shadow.inspect().candidatesPage.length, 1);
  reopened.shadow.erase();
  assert.equal(reopened.shadow.status().episodes, 0);
  assert.equal(reopened.store.getControl("shadow:delivery-day:2026-10-25"), 2);
  assert.deepEqual(
    reopened.store.getControl("personality:synthetic-preserve"),
    { value: "keep" },
  );
  reopened.close();
});
test("native experimental tool is opt-in and exposes no force or path override", async () => {
  const tools = new Map(),
    disposers = [];
  const root = mkdtempSync(join(tmpdir(), "shadow-contract-"));
  apply(
    {
      tools: { register: (t) => tools.set(t.name, t), guard: () => {} },
      on: () => {},
      effect: (setup) => disposers.push(setup()),
    },
    { dataDir: root, enablePersonalityShadow: true },
  );
  assert.equal(tools.size, 15);
  const tool = tools.get("bili_humanism_shadow");
  assert.equal(
    JSON.parse(await tool.execute({ action: "read" }, { agent: { id: "a" } }))
      .mode,
    "experimental_personality",
  );
  assert.equal(
    JSON.parse(
      await tool.execute(
        { action: "read", force: true },
        { agent: { id: "a" } },
      ),
    ).error,
    "UNKNOWN_PARAMETER",
  );
  for (const fn of disposers) fn();
});

function prepareSelection(f, owner = "a", change = {}) {
  f.emit(
    owner,
    "Synthetic: I am sharing this moment; please let me finish before giving a plan.",
  );
  const snapshot = f.read(owner),
    body = { ...proposal(snapshot), ...change };
  const saved = f.shadow.tool(
    {
      action: "propose",
      snapshotId: snapshot.snapshotId,
      json: JSON.stringify(body),
    },
    f.exec(owner),
  );
  const args = {
    action: "select",
    candidateId: saved.id,
    sentence: body.conditionalResponse,
  };
  return {
    snapshot,
    body,
    saved,
    args,
    select: () => f.shadow.tool(args, f.exec(owner)),
  };
}
function syntheticJournal(f, created = "2026-10-24T10:00:00Z") {
  const reading = f.service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 1,
    duration: 60,
    title: "Synthetic quota fixture",
    route: "A1",
    segments: [],
    coverage: { state: "no_subtitles" },
  });
  const sentence = "合成手账反思：把未了解的部分保留为疑问。";
  const id = f.service.store.note(reading.id, {
    encounter: "Synthetic",
    missing: "Synthetic limits",
    revision: sentence,
    next_response: "",
    evidence: [],
  });
  f.service.store.db
    .prepare("UPDATE notes SET created=? WHERE id=?")
    .run(created, id);
  return { journalId: id, sentence };
}

test("explicit experiment select enters formal personality with context/provenance, survives reopen and exact retries", () => {
  const f = fixture();
  const p = prepareSelection(f);
  assert.equal(p.saved.status, "pending_selection");
  assert.equal(p.snapshot.formalPersonality.total, 0);
  assert.equal(f.service.personality("read").total, 0);
  const selected = p.select();
  assert.equal(selected.active, true);
  assert.equal(selected.sourceKind, "interaction");
  assert.equal(selected.candidateId, p.saved.id);
  const official = f.service.personality("read");
  assert.equal(official.total, 1);
  assert.equal(official.entries[0].sentence, p.body.conditionalResponse);
  assert.equal(official.entries[0].counterexample, p.body.counterexample);
  const text = readFileSync(join(f.root, "human-world.md"), "utf8");
  assert.ok(
    text.includes(p.saved.id) &&
      text.includes("适用处境") &&
      text.includes("反例"),
  );
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    0,
  );
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM memory").get().n,
    0,
  );
  assert.equal(p.select().status, "already_selected");
  f.service.close();
  const reopened = new Service({
    dataDir: f.root,
    enablePersonalityShadow: true,
  });
  assert.equal(reopened.personality("read").entries[0].candidateId, p.saved.id);
  assert.equal(reopened.shadow.inspect().candidatesPage[0].active, true);
  reopened.close();
});

test("journal-first and interaction-first selections share the same actual-day quota across source dates", () => {
  for (const journalFirst of [true, false]) {
    const f = fixture(),
      journal = syntheticJournal(f),
      p = prepareSelection(f);
    if (journalFirst) {
      f.service.personality("select", journal);
      assert.throws(p.select, { code: "PERSONALITY_DAILY_LIMIT" });
      assert.equal(
        f.shadow.inspect().candidatesPage[0].status,
        "pending_selection",
      );
    } else {
      p.select();
      assert.throws(() => f.service.personality("select", journal), {
        code: "PERSONALITY_DAILY_LIMIT",
      });
    }
    assert.equal(f.service.personality("read").total, 1);
    f.service.close();
  }
});

test("interaction selections preserve source-day quota and late retries do not spend tomorrow's quota", () => {
  const f = fixture(),
    first = prepareSelection(f);
  first.select();
  f.nextDay();
  assert.equal(first.select().status, "already_selected");
  const current = prepareSelection(f, "b", {
    conditionalResponse: "合成反思：在新的处境中先核对对方现在要什么。",
  });
  assert.equal(current.select().active, true);
  f.nextDay();
  const human = f.emit("c", "Synthetic different same-source-day encounter");
  // Trusted fixture stamps the genuine source time, independent of selection day.
  const row = f.service.store.db
    .prepare("SELECT id FROM shadow_episodes WHERE user_id=?")
    .get(human.message.id);
  f.service.store.db
    .prepare("UPDATE shadow_episodes SET created=? WHERE id=?")
    .run(Date.parse("2026-10-25T12:00:00Z"), row.id);
  const read = f.read("c"),
    body = {
      ...proposal(read),
      conditionalResponse: "合成反思：另一个同来源日的理解不应挤掉既有条目。",
    };
  const saved = f.shadow.tool(
    {
      action: "propose",
      snapshotId: read.snapshotId,
      json: JSON.stringify(body),
    },
    f.exec("c"),
  );
  assert.throws(
    () =>
      f.shadow.tool(
        {
          action: "select",
          candidateId: saved.id,
          sentence: body.conditionalResponse,
        },
        f.exec("c"),
      ),
    { code: "PERSONALITY_DAY_ALREADY_SELECTED" },
  );
  f.service.close();
});

test("uncertain, skipped, wrong-owner and arbitrary-sentence candidates cannot enter formal personality", () => {
  const f = fixture(),
    p = prepareSelection(f, "a", { kind: "uncertain" });
  assert.throws(p.select, { code: "INTERACTION_UNDERSTANDING_UNCERTAIN" });
  assert.throws(() => f.shadow.tool(p.args, f.exec("foreign")), {
    code: "INTERACTION_SELECTION_REVIEW_REQUIRED",
  });
  f.shadow.tool(
    {
      action: "skip",
      snapshotId: p.snapshot.snapshotId,
      reason: "insufficient_context",
    },
    f.exec("a"),
  );
  assert.throws(p.select, { code: "INTERACTION_CANDIDATE_NOT_SELECTABLE" });
  const other = prepareSelection(f, "b");
  assert.throws(
    () =>
      f.shadow.tool(
        {
          ...other.args,
          sentence: "Invented understanding that was never proposed",
        },
        f.exec("b"),
      ),
    { code: "PERSONALITY_REFLECTION_REQUIRED" },
  );
  assert.equal(f.service.personality("read").total, 0);
  f.service.close();
});

test("a candidate needs today's formal-context read, cancellation preserves it for a resumed review", () => {
  const f = fixture(),
    p = prepareSelection(f);
  assert.throws(
    () =>
      f.shadow.tool(p.args, {
        agent: { id: "a" },
        signal: AbortSignal.abort(),
      }),
    { code: "CANCELLED" },
  );
  f.nextDay();
  assert.throws(p.select, { code: "INTERACTION_SELECTION_REVIEW_REQUIRED" });
  const resumed = f.read("a");
  assert.equal(resumed.candidate.id, p.saved.id);
  assert.equal(resumed.formalPersonality.total, 0);
  assert.equal(p.select().active, true);
  f.service.close();
  const boundary = fixture(),
    next = prepareSelection(boundary);
  let calls = 0;
  boundary.shadow.clock = () =>
    calls++ === 0
      ? Date.parse("2026-10-25T15:59:59.999Z")
      : Date.parse("2026-10-25T16:00:00Z");
  assert.equal(next.select().selectedAt, "2026-10-25T15:59:59.999Z");
  assert.equal(calls, 1);
  assert.ok(
    boundary.service.store.getControl("personality:selected-on:2026-10-25"),
  );
  assert.equal(
    boundary.service.store.getControl("personality:selected-on:2026-10-26"),
    null,
  );
  boundary.service.close();
});

test("legacy shadow candidates are not promoted or automatically backfilled on upgrade", () => {
  const f = fixture(),
    p = prepareSelection(f);
  f.service.store.db
    .prepare("UPDATE shadow_candidates SET status='shadow' WHERE id=?")
    .run(p.saved.id);
  f.service.store.db
    .prepare(
      "UPDATE shadow_episodes SET status='shadow' WHERE id=(SELECT episode_id FROM shadow_candidates WHERE id=?)",
    )
    .run(p.saved.id);
  f.service.store.db
    .prepare("DELETE FROM control WHERE key LIKE 'shadow:selection-%'")
    .run();
  assert.equal(f.read("a").pending, false);
  assert.throws(p.select, { code: "INTERACTION_SELECTION_REVIEW_REQUIRED" });
  f.shadow.continue({
    agent: {
      id: "a",
      status: "running",
      steer: () => assert.fail("Legacy candidates cannot wake the agent"),
    },
    turn: 1,
  });
  assert.equal(f.service.personality("read").total, 0);
  f.service.close();
});

test("formal file integrity failure rolls back candidate activation and quotas without discarding it", () => {
  const f = fixture(),
    p = prepareSelection(f);
  writeFileSync(join(f.root, "human-world.md"), "Synthetic unowned human file");
  assert.throws(p.select, { code: "PERSONALITY_FILE_UNOWNED" });
  assert.equal(
    f.shadow.inspect().candidatesPage[0].status,
    "pending_selection",
  );
  assert.equal(
    f.service.store.getControl("personality:selected-on:2026-10-25"),
    null,
  );
  f.service.close();
});

test("trusted interaction revision/retraction work; erasure cannot orphan active personality or reset quotas", () => {
  const f = fixture(),
    p = prepareSelection(f);
  p.select();
  assert.throws(() => f.shadow.erase(), {
    code: "SHADOW_ACTIVE_PERSONALITY_REQUIRES_RETRACTION",
  });
  const revised = revisePersonality(
    f.service.store,
    "2026-10-25",
    p.saved.id,
    "先回应其珍视的细节",
  );
  assert.equal(revised.status, "revised");
  assert.equal(
    f.service.personality("read").entries[0].sentence,
    "先回应其珍视的细节",
  );
  deletePersonality(f.service.store, "2026-10-25");
  assert.equal(f.service.personality("read").total, 0);
  assert.equal(f.shadow.inspect().candidatesPage[0].active, false);
  assert.throws(p.select, { code: "INTERACTION_CANDIDATE_NOT_SELECTABLE" });
  f.shadow.erase();
  assert.ok(f.service.store.getControl("personality:selected-on:2026-10-25"));
  assert.ok(f.service.store.getControl("personality:retracted:2026-10-25"));
  f.service.close();
});

test("trusted source replacement resolves the new review and retracts both sources on deletion", () => {
  const f = fixture(),
    first = prepareSelection(f);
  first.select();
  const second = prepareSelection(f, "b", {
    conditionalResponse: "合成反思：在共同欣赏的处境中留出回应的空间。",
  });
  revisePersonality(
    f.service.store,
    "2026-10-25",
    second.saved.id,
    second.body.conditionalResponse,
  );
  assert.equal(f.shadow.status().pending, 0);
  const rows = f.shadow.inspect().candidatesPage;
  assert.equal(rows.find((r) => r.id === first.saved.id).active, false);
  assert.equal(rows.find((r) => r.id === second.saved.id).active, true);
  deletePersonality(f.service.store, "2026-10-25");
  assert.ok(
    f.shadow
      .inspect()
      .candidatesPage.every((r) => r.status === "retracted" && !r.active),
  );
  assert.equal(f.shadow.erase().shadowErased, true);
  f.service.close();
});

test("one review cannot consume old pending episodes, replay cannot release the shadow guard", () => {
  const f = fixture();
  f.emit("a", "Synthetic older episode");
  const current = f.emit("a", "Synthetic current episode");
  const s = f.read("a");
  f.shadow.tool(
    {
      action: "skip",
      snapshotId: s.snapshotId,
      reason: "no_new_understanding",
    },
    f.exec("a"),
  );
  assert.equal(f.read("a").pending, false);
  assert.equal(f.shadow.status().pending, 1);
  f.shadow.observe({ header: { id: "a" } }, current.event);
  assert.equal(f.service.store.getControl("shadow:review-phase:a"), true);
  f.shadow.continue({
    agent: { id: "a", status: "running", steer: () => assert.fail() },
    turn: 1,
  });
  assert.ok(f.read("a").anchorId);
  f.service.close();
});

test("large evidence reduces related context below 60KB, hash substitutions fail explicitly", () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    f.emit("s" + i, "x".repeat(6000));
    f.emit("s" + i, "y".repeat(6000), "assistant");
  }
  const s = f.read("s5");
  assert.ok(s.episodes.length < 6);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) < 61000);
  assert.equal(s.contextComplete, false);
  const id = s.episodes[0].evidence[0].messageId;
  f.service.store.db
    .prepare("UPDATE shadow_messages SET body=? WHERE id=?")
    .run(JSON.stringify({ text: "Changed private text" }), id);
  assert.throws(() => f.read("s5"), { code: "SHADOW_EVIDENCE_CHANGED" });
  f.service.close();
});

test("message capacity is explicit and shared hosts cannot spend a second automatic review slot", () => {
  const f = fixture({ shadowMaxReviewsPerDay: 1 }),
    messages = [];
  f.emit("a", "Synthetic first episode");
  f.emit("b", "Synthetic second episode");
  const other = new Service(
    {
      dataDir: f.root,
      enablePersonalityShadow: true,
      shadowMaxReviewsPerDay: 1,
    },
    { shadow: { now: () => Date.parse("2026-10-25T10:00:00Z") } },
  );
  f.shadow.continue({
    agent: { id: "a", status: "running", steer: (m) => messages.push(m) },
    turn: 1,
  });
  other.shadow.continue({
    agent: { id: "b", status: "running", steer: (m) => messages.push(m) },
    turn: 1,
  });
  assert.equal(messages.length, 1);
  f.service.store.tx(() => {
    const insert = f.service.store.db.prepare(
      "INSERT INTO shadow_messages VALUES(?,?,?,?,?,?,?)",
    );
    for (let i = 2; i < 10000; i++)
      insert.run(
        "synthetic-fill-" + i,
        "fill",
        i,
        "user",
        0,
        "{}",
        "synthetic-unused-hash",
      );
  });
  f.emit("c", "Synthetic overflow must be reported");
  assert.equal(f.shadow.status().episodes, 2);
  assert.ok(
    f.shadow.status().diagnostics.some((d) => d.code === "SHADOW_STORAGE_FULL"),
  );
  other.close();
  f.service.close();
});

test("passive shadow hook faults cannot fail the human turn or expose exception text", () => {
  const f = fixture(),
    hooks = new Map();
  attachPersonalityShadow(
    {
      on: (name, fn) => hooks.set(name, fn),
      effect: () => {},
      tools: { guard: () => {} },
    },
    f.shadow,
  );
  f.shadow.observe = () => {
    throw Error("Synthetic private raw exception must not be logged");
  };
  f.shadow.continue = () => {
    throw Error("Synthetic private raw exception must not be logged");
  };
  assert.doesNotThrow(() => hooks.get("session/event")({}, {}));
  assert.doesNotThrow(() => hooks.get("agent/turn-stopping")({}));
  assert.equal(f.shadow.status().observerError, "INTERNAL_ERROR");
  f.service.close();
});
