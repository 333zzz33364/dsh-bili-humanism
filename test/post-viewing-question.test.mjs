import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";

const question = "我还拿不准他那次停顿的意思；如果是你，会怎样理解这个选择？";
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "humanism-question-"));
  let time = Date.parse("2026-10-26T10:00:00Z"),
    seq = 0;
  const service = new Service(
    { dataDir: root, ...config },
    {
      questions: { now: () => time },
      fetcher: () => assert.fail("No network"),
    },
  );
  t.after(() => service.close());
  const q = service.questions,
    messages = [],
    owner = "synthetic-owner";
  const agent = {
    id: owner,
    status: "running",
    steer: (m) => messages.push(m),
  };
  const exec = { agent, signal: new AbortController().signal };
  const session = { header: { id: owner }, inheritedEventCount: 0 };
  function event(type, data, other = session) {
    const e = { type, data, seq: ++seq, time: ++time };
    q.observe(other, e);
    return e;
  }
  const start = (turn = 1) => event("turn/start", { turn });
  start();
  const reading = service.store.saveReading({
    bvid: "BV0000000001",
    page: 1,
    cid: 1,
    title: "Synthetic source",
    duration: 60,
    route: "A1",
    segments: [],
    coverage: { state: "partial" },
  });
  const body = (revision = "合成反思：不能把停顿直接理解为拒绝。") => ({
    encounter: "Synthetic encounter",
    revision,
    missing: "我还不清楚停顿的含义。",
    evidence: [],
  });
  const save = (revision) => service.journal(reading.id, body(revision));
  const call = (action, journalId, args = {}, execution = exec) =>
    q.tool({ action, journalId, ...args }, execution);
  const setup = () => {
    const saved = save();
    q.bind(saved.id, exec);
    q.continue({ agent, turn: 1, signal: exec.signal });
    return saved;
  };
  const prepare = (id) => {
    call("read", id);
    return call("prepare", id, {
      question,
      field: "missing",
      quote: "我还不清楚停顿的含义。",
      why: "这会改变我对人的选择的解释，而不是只补全事实。",
    });
  };
  const assistant = (text = question, extra = {}) =>
    event("assistant/message", {
      message: {
        id: "assistant-" + seq,
        role: "assistant",
        source: { kind: "model" },
        content: [{ type: "text", text }],
      },
      ...extra,
    });
  const user = (text, source = "user") =>
    event("user/message", {
      id: "user-" + seq,
      role: "user",
      source: { kind: source },
      content: [{ type: "text", text }],
    });
  return {
    root,
    service,
    q,
    agent,
    exec,
    session,
    messages,
    event,
    start,
    save,
    call,
    setup,
    prepare,
    assistant,
    user,
  };
}
test("new journal and question are one transaction; exact retries reuse IDs and legacy journals do not backfill", (t) => {
  const f = fixture(t),
    saved = f.save();
  assert.equal(saved.question.status, "pending");
  const retry = f.save();
  assert.equal(retry.id, saved.id);
  assert.equal(retry.question.id, saved.question.id);
  const original = f.q.queue.bind(f.q);
  f.q.queue = () => {
    throw Error("Synthetic queue failure");
  };
  assert.throws(() => f.save("Synthetic different reflection"));
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    1,
  );
  f.q.queue = original;
  f.service.store.db
    .prepare("DELETE FROM control WHERE key=?")
    .run("post-viewing:journal:" + saved.id);
  assert.equal(f.save().question.status, "not_queued_legacy");
});
test("question default is enabled but dedicated switch or disabled personality learning removes all new work", (t) => {
  for (const config of [
    { enablePostViewingQuestions: false },
    { enablePersonalityLearning: false },
  ]) {
    const f = fixture(t, config),
      saved = f.save();
    assert.equal(f.q.enabled, false);
    assert.equal(saved.question.status, "disabled");
    f.q.continue({ agent: f.agent, turn: 1 });
    assert.equal(f.messages.length, 0);
    assert.throws(() => f.call("read", saved.id), {
      code: "POST_VIEWING_QUESTIONS_DISABLED",
    });
  }
});
test("stop-boundary steering happens once, uses only saved ID and never copies source prose", (t) => {
  const f = fixture(t),
    saved = f.setup();
  f.q.bind(saved.id, f.exec);
  f.q.continue({ agent: f.agent, turn: 1 });
  f.q.continue({ agent: f.agent, turn: 1 });
  assert.equal(f.messages.length, 1);
  assert.equal(
    f.messages[0].source.kind,
    "bili-humanism-post-viewing-question",
  );
  assert.ok(f.messages[0].content[0].text.includes(saved.id));
  assert.ok(!JSON.stringify(f.messages).includes("我还不清楚停顿"));
  assert.equal(f.q.existing(saved.id).delivery, "unconfirmed");
});
test("prepare needs an owned current read and exact journal anchor, no arbitrary dispatch, paths or force", (t) => {
  const f = fixture(t),
    saved = f.setup();
  assert.throws(() => f.call("prepare", saved.id, { question }), {
    code: "QUESTION_READ_REQUIRED",
  });
  assert.throws(
    () => f.call("read", saved.id, {}, { agent: { id: "foreign" } }),
    { code: "QUESTION_REVIEW_NOT_FOUND" },
  );
  f.call("read", saved.id);
  const args = {
    question,
    field: "missing",
    quote: "Invented source",
    why: "Synthetic reason",
  };
  assert.throws(() => f.call("prepare", saved.id, args), {
    code: "QUESTION_ANCHOR_MISMATCH",
  });
  assert.throws(() => f.call("read", saved.id, { force: true }), {
    code: "UNKNOWN_PARAMETER",
  });
  assert.throws(() => f.call("send", saved.id), {
    code: "INVALID_QUESTION_ACTION",
  });
  assert.throws(
    () =>
      f.call("prepare", saved.id, { ...args, question: "你怎么看？为什么？" }),
    { code: "ONE_DIRECT_QUESTION_REQUIRED" },
  );
});
test("registration is not asking: only a committed plain assistant question verifies delivery", (t) => {
  const f = fixture(t),
    saved = f.setup();
  assert.equal(f.prepare(saved.id).deliveryVerified, false);
  assert.equal(f.q.existing(saved.id).status, "prepared");
  f.event("tool/result", { question });
  f.assistant(question, { interrupted: true });
  f.assistant("```\n" + question + "\n```");
  f.assistant("> " + question);
  assert.equal(f.q.existing(saved.id).status, "prepared");
  f.assistant("本地简报已整理。\n\n" + question);
  assert.equal(f.q.existing(saved.id).status, "asked");
  assert.equal(f.q.existing(saved.id).delivery, "assistant_message_verified");
});
test("same prepared question is idempotent, replacements and repeat delivery are not newly counted", (t) => {
  const f = fixture(t),
    saved = f.setup();
  const a = f.prepare(saved.id),
    b = f.prepare(saved.id);
  assert.equal(a.id, b.id);
  assert.equal(b.deduplicated, true);
  assert.throws(
    () =>
      f.call("prepare", saved.id, {
        question: "你会怎样理解另一个细节？",
        field: "missing",
        quote: "我还不清楚停顿的含义。",
        why: "Synthetic reason",
      }),
    { code: "QUESTION_ALREADY_PREPARED" },
  );
  f.assistant();
  const first = f.q.existing(saved.id).askedMessageId;
  f.assistant();
  assert.equal(f.q.existing(saved.id).askedMessageId, first);
  assert.equal(f.prepare(saved.id).doNotRepeat, true);
});
test("silence is not feedback; the next genuine human message is only an unreviewed possible reply", (t) => {
  const f = fixture(t),
    saved = f.setup();
  f.prepare(saved.id);
  f.assistant();
  f.user("Synthetic injected approval", "agent-instructions");
  assert.equal(f.q.existing(saved.id).status, "asked");
  f.user("我现在不想回答这个问题。");
  const row = f.q.existing(saved.id);
  assert.equal(row.status, "responded_unreviewed");
  assert.ok(row.reply.role.includes("not_agreement"));
  f.user("Synthetic later unrelated turn");
  assert.equal(f.q.existing(saved.id).reply.messageId, row.reply.messageId);
  assert.equal(existsSync(join(f.root, "human-world.md")), false);
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM memory").get().n,
    0,
  );
});
test("credential-like and oversized replies are omitted instead of stored as raw content", (t) => {
  const f = fixture(t),
    saved = f.setup();
  f.prepare(saved.id);
  f.assistant();
  f.user("Authorization: Bearer SYNTHETIC_NOT_REAL");
  const row = f.q.existing(saved.id);
  assert.equal(row.reply.omitted, "possible_credential");
  assert.ok(!JSON.stringify(row).includes("SYNTHETIC_NOT_REAL"));
});
test("user refusal can skip without reading; no question or persona write is forced", (t) => {
  const f = fixture(t),
    saved = f.setup();
  assert.equal(
    f.call("skip", saved.id, { reason: "user_declined" }).status,
    "skipped",
  );
  f.q.continue({ agent: f.agent, turn: 1 });
  assert.equal(f.q.status().counts.skipped, 1);
  assert.equal(f.q.status().counts.asked, undefined);
  assert.equal(f.service.personality("read").total, 0);
});
test("idle, cancellation and unavailable continuation never wake agents or discard the journal", (t) => {
  const f = fixture(t),
    saved = f.save();
  f.q.bind(saved.id, f.exec);
  f.q.continue({ agent: { ...f.agent, status: "idle" }, turn: 1 });
  f.q.continue({ agent: f.agent, turn: 1, signal: AbortSignal.abort() });
  f.q.continue({ agent: { ...f.agent, steer: undefined }, turn: 1 });
  assert.equal(f.messages.length, 0);
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    1,
  );
});
test("interrupted preparation stays unconfirmed, stale phases do not block a later turn after restart", (t) => {
  const f = fixture(t),
    saved = f.setup();
  f.prepare(saved.id);
  f.event("turn/end", { turn: 1, reason: { kind: "cancelled" } });
  assert.equal(f.q.existing(saved.id).delivery, "unconfirmed");
  f.service.store.setControl("post-viewing:phase:" + f.agent.id, {
    journalId: saved.id,
    turn: 1,
  });
  f.start(2);
  assert.equal(
    f.service.store.getControl("post-viewing:phase:" + f.agent.id),
    null,
  );
  f.q.continue({ agent: f.agent, turn: 2 });
  assert.equal(f.messages.length, 1);
  assert.throws(() => f.call("read", saved.id), {
    code: "QUESTION_CURRENT_REVIEW_REQUIRED",
  });
});
test("question boundary defers cross-session experiment until after a genuine human response", (t) => {
  const f = fixture(t, { enablePersonalityShadow: true }),
    saved = f.setup();
  const event = {
    type: "user/message",
    seq: 1,
    time: Date.now(),
    data: {
      id: "synthetic-human",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Synthetic source context" }],
    },
  };
  f.service.shadow.observe(f.session, event);
  f.service.shadow.continue({ agent: f.agent, turn: 1 });
  assert.equal(f.messages.length, 1);
  f.prepare(saved.id);
  f.assistant();
  f.q.continue({ agent: f.agent, turn: 1 });
  f.service.shadow.continue({ agent: f.agent, turn: 1 });
  assert.equal(f.messages.length, 1);
  f.start(2);
  f.service.shadow.continue({ agent: f.agent, turn: 2 });
  assert.equal(f.messages.at(-1).source.kind, "bili-humanism-shadow-review");
});

test("direct in-turn question preparation is observed without waiting for steering", (t) => {
  const f = fixture(t),
    saved = f.save();
  f.q.bind(saved.id, f.exec);
  f.prepare(saved.id);
  f.assistant();
  assert.equal(f.messages.length, 0);
  assert.equal(f.q.existing(saved.id).status, "asked");
  f.q.continue({ agent: f.agent, turn: 1 });
  assert.equal(f.messages.length, 0);
});

test("trusted deletion preserves the journal and does not requeue the old brief", (t) => {
  const f = fixture(t),
    saved = f.setup();
  f.prepare(saved.id);
  f.assistant();
  f.user("合成回复：这次也许只是犹豫。");
  assert.equal(
    f.q.inspect().entries[0].reply.text,
    "合成回复：这次也许只是犹豫。",
  );
  f.q.delete(saved.id);
  assert.equal(f.q.inspect().entries.length, 0);
  assert.equal(
    f.service.store.db.prepare("SELECT count(*) n FROM notes").get().n,
    1,
  );
  assert.equal(f.save().question.status, "not_queued_legacy");
  assert.throws(() => f.call("delete", saved.id), {
    code: "QUESTION_REVIEW_NOT_FOUND",
  });
});

test("new-turn guard recovers from stale phase and restores ordinary tools", (t) => {
  const f = fixture(t);
  let guard;
  f.q.attach({
    on: () => {},
    tools: {
      guard: (fn) => {
        guard = fn;
      },
    },
    effect: () => {},
  });
  const saved = f.setup();
  assert.equal(
    guard({ agent: f.agent, name: "bili_humanism_memory" }),
    "POST_VIEWING_QUESTION_TOOLS_ONLY",
  );
  f.start(2);
  assert.equal(
    guard({ agent: f.agent, name: "bili_humanism_memory" }),
    undefined,
  );
  assert.equal(f.q.existing(saved.id).delivery, "unconfirmed");
});
