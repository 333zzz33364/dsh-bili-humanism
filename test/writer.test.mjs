import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../lib/service.mjs";
import { accountStore, resolveUnknown, resumeWrites } from "../lib/writer.mjs";
import { apply } from "../index.js";
import { Network } from "../lib/network.mjs";

const bv = "BV0000000001";
const response = (data) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "content-type": "application/json" },
  });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "humanism-writes-"));
  const config = {
    dataDir: join(root, "local"),
    credentialPath: join(root, "credential.json"),
    writePolicyPath: join(root, "grant.json"),
    accountStateDir: join(root, "accounts"),
    enableHistoryWrites: true,
    enableFavoriteWrites: true,
    enableLikeWrites: false,
    enableCoinWrites: false,
  };
  writeFileSync(
    config.credentialPath,
    JSON.stringify({
      sessdata: "synthetic-session",
      bili_jct: "a".repeat(32),
      buvid3: "synthetic-existing-device",
    }),
  );
  const policy = {
    version: 1,
    id: "synthetic-grant",
    enabled: true,
    handoverConfirmed: true,
    accountId: "123",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    videos: [bv],
    history: { enabled: true, maxWrites: 3 },
    likes: { enabled: true, maxWrites: 3 },
    coins: { enabled: true, maxWrites: 3, maxCoins: 2, maxPerVideo: 2 },
    favorites: {
      enabled: true,
      maxWrites: 3,
      folders: [{ id: "456", visibility: "private", allowRemove: false }],
    },
  };
  const save = () =>
    writeFileSync(config.writePolicyPath, JSON.stringify(policy));
  save();
  const calls = [];
  let favorite = false,
    progress = 0,
    liked = false,
    coins = 0;
  const hooks = {};
  const fetcher = async (u, options) => {
    const url = new URL(u);
    calls.push({ url, options });
    if (hooks.before) await hooks.before(url, options);
    if (url.pathname.endsWith("/nav"))
      return response({ isLogin: true, mid: 123 });
    if (url.pathname.endsWith("/view"))
      return response({
        bvid: bv,
        aid: 99,
        pages: [{ page: 1, cid: 7, duration: 60 }],
      });
    if (url.pathname.endsWith("/list-all"))
      return response({
        list: [
          {
            id: 456,
            mid: 123,
            attr: hooks.public ? 0 : 1,
            fav_state: favorite ? 1 : 0,
          },
        ],
      });
    if (url.pathname.endsWith("/cursor"))
      return response({
        list: progress ? [{ history: { oid: 99, cid: 7 }, progress }] : [],
      });
    if (url.pathname.endsWith("/has/like"))
      return response(hooks.likeState ?? (liked ? 1 : 0));
    if (url.pathname.endsWith("/archive/coins"))
      return response({ multiply: hooks.coinState ?? coins });
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.ok(options.headers.Cookie.includes("bili_jct="));
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("csrf"), "a".repeat(32));
    if (url.pathname.endsWith("/deal"))
      favorite = body.get("add_media_ids") === "456";
    else if (url.pathname.endsWith("/report"))
      progress = Number(body.get("progress"));
    else if (url.pathname.endsWith("/archive/like")) {
      assert.equal(body.get("like"), "1");
      liked = true;
    } else if (url.pathname.endsWith("/coin/add")) {
      assert.equal(body.get("select_like"), "0");
      coins += Number(body.get("multiply"));
    } else assert.fail("Unexpected route");
    if (hooks.post) return hooks.post(url, options);
    return response({});
  };
  const service = new Service(config, { fetcher });
  const reading = service.store.saveReading({
    bvid: bv,
    page: 1,
    cid: 7,
    duration: 60,
    title: "Synthetic source",
    segments: [],
    route: "A1",
    coverage: { state: "no_subtitles" },
  });
  const favoriteArgs = {
    readingId: reading.id,
    folderId: "456",
    action: "add",
  };
  const state = (fn) => {
    const db = accountStore(config, "123");
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const cool = () => state((db) => db.setControl("write:last", 0));
  return {
    config,
    policy,
    save,
    calls,
    hooks,
    service,
    reading,
    favoriteArgs,
    state,
    cool,
    get posts() {
      return calls.filter((c) => c.options.method === "POST");
    },
  };
}
const rejects = (promise, code) =>
  assert.rejects(promise, (e) => e.code === code);

test("write switches register only selected capabilities and have no default traffic", async () => {
  for (const [history, favorites, expected] of [
    [false, false, 13],
    [true, false, 14],
    [false, true, 14],
    [true, true, 15],
  ]) {
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
        on(_event, fn) {
          dispose = fn;
        },
      },
      {
        ...f.config,
        enableDailyFetching: false,
        enableHistoryWrites: history,
        enableFavoriteWrites: favorites,
      },
    );
    assert.equal(tools.size, expected);
    const status = JSON.parse(
      await tools.get("bili_humanism_status").execute({}, {}),
    );
    assert.equal(status.platformWriteTools.length, expected - 13);
    assert.equal(f.calls.length, 0);
    dispose();
    f.service.close();
  }
});

test("closed switches, expired grants, revoked scope and off-scope sources fail before traffic", async () => {
  for (const mode of [
    "switch",
    "expired",
    "revoked",
    "scope",
    "target",
    "handover",
  ]) {
    const f = fixture();
    if (mode === "switch") f.service.config.enableFavoriteWrites = false;
    if (mode === "expired") f.policy.expiresAt = "2000-01-01T00:00:00Z";
    if (mode === "revoked") f.policy.enabled = false;
    if (mode === "scope") f.policy.favorites.enabled = false;
    if (mode === "target") f.policy.videos = ["BVxxxxxxxxxx"];
    if (mode === "handover") f.policy.handoverConfirmed = false;
    f.save();
    await assert.rejects(f.service.platformWrite("favorites", f.favoriteArgs));
    assert.equal(f.calls.length, 0);
    f.service.close();
  }
});

test("favorite add is verified, duplicate is a no-op, removal needs distinct authorization", async () => {
  const f = fixture();
  assert.equal(
    (await f.service.platformWrite("favorites", f.favoriteArgs)).result.status,
    "verified",
  );
  assert.equal(
    (await f.service.platformWrite("favorites", f.favoriteArgs)).result.status,
    "already_in_desired_state",
  );
  await rejects(
    f.service.platformWrite("favorites", {
      ...f.favoriteArgs,
      action: "remove",
    }),
    "FAVORITE_REMOVE_DENIED",
  );
  f.policy.favorites.folders[0].allowRemove = true;
  f.save();
  f.cool();
  assert.equal(
    (
      await f.service.platformWrite("favorites", {
        ...f.favoriteArgs,
        action: "remove",
      })
    ).result.status,
    "verified",
  );
  assert.equal(f.posts.length, 2);
  assert.equal(
    f.state((db) => db.getControl("quota:synthetic-grant:favorites")),
    2,
  );
  f.service.close();
});

test("account identity mismatch persists pause and never dispatches a write", async () => {
  const f = fixture();
  f.policy.accountId = "124";
  f.save();
  await rejects(
    f.service.platformWrite("favorites", f.favoriteArgs),
    "WRITE_ACCOUNT_MISMATCH",
  );
  assert.equal(f.posts.length, 0);
  assert.equal(f.service.store.status().pause.reason, "WRITE_ACCOUNT_MISMATCH");
  f.service.close();
});

test("folder visibility or folder scope mismatch cannot silently publish favorites", async () => {
  for (const mode of ["visibility", "folder"]) {
    const f = fixture();
    if (mode === "visibility") f.hooks.public = true;
    else f.favoriteArgs.folderId = "457";
    await rejects(
      f.service.platformWrite("favorites", f.favoriteArgs),
      mode === "visibility"
        ? "FAVORITE_VISIBILITY_CHANGED"
        : "FAVORITE_FOLDER_DENIED",
    );
    assert.equal(f.posts.length, 0);
    f.service.close();
  }
});

test("revocation and credential replacement during preflight are checked again before POST", async () => {
  for (const mode of ["grant", "credential"]) {
    const f = fixture();
    f.hooks.before = (url) => {
      if (url.pathname.endsWith("/list-all")) {
        if (mode === "grant") {
          f.policy.enabled = false;
          f.save();
        } else
          writeFileSync(
            f.config.credentialPath,
            JSON.stringify({
              sessdata: "different-session",
              bili_jct: "b".repeat(32),
            }),
          );
      }
    };
    await assert.rejects(f.service.platformWrite("favorites", f.favoriteArgs));
    assert.equal(f.posts.length, 0);
    f.service.close();
  }
});

test("missing CSRF cannot trigger any platform request or leak its value", async () => {
  const f = fixture();
  writeFileSync(
    f.config.credentialPath,
    JSON.stringify({ sessdata: "synthetic-session" }),
  );
  await rejects(
    f.service.platformWrite("favorites", f.favoriteArgs),
    "WRITE_CREDENTIAL_INVALID",
  );
  assert.equal(f.calls.length, 0);
  f.service.close();
});

test("write quota and minimum interval persist across Service instances", async () => {
  const f = fixture();
  f.policy.favorites.maxWrites = 1;
  f.policy.favorites.folders[0].allowRemove = true;
  f.save();
  await f.service.platformWrite("favorites", f.favoriteArgs);
  const other = new Service(f.config, { fetcher: f.service.fetcher });
  await rejects(
    other.platformWrite("favorites", { ...f.favoriteArgs, action: "remove" }),
    "WRITE_QUOTA_EXHAUSTED",
  );
  assert.equal(f.posts.length, 1);
  other.close();
  f.service.close();
  const g = fixture();
  g.policy.favorites.folders[0].allowRemove = true;
  g.save();
  await g.service.platformWrite("favorites", g.favoriteArgs);
  await rejects(
    g.service.platformWrite("favorites", {
      ...g.favoriteArgs,
      action: "remove",
    }),
    "WRITE_RATE_LIMIT",
  );
  assert.equal(g.posts.length, 1);
  g.service.close();
});

test("POST timeout, malformed response and redirect become durable unknown outcomes without retry", async () => {
  for (const mode of ["timeout", "invalid", "redirect", "risk"]) {
    const f = fixture();
    f.hooks.post = () => {
      if (mode === "timeout")
        throw new Error("synthetic-session must not leak");
      return new Response(mode === "invalid" ? "unexpected content" : "", {
        status: mode === "redirect" ? 302 : mode === "risk" ? 412 : 200,
      });
    };
    await rejects(
      f.service.platformWrite("favorites", f.favoriteArgs),
      "WRITE_RESULT_UNKNOWN",
    );
    const pending = f.state((db) => db.getControl("write:pending"));
    assert.ok(pending.id);
    f.service.close();
    const other = new Service(
      { ...f.config, dataDir: join(f.config.dataDir, "another-profile") },
      { fetcher: f.service.fetcher },
    );
    const id = other.store.saveReading({ ...f.reading }).id;
    await rejects(
      other.platformWrite("favorites", { ...f.favoriteArgs, readingId: id }),
      "PERSISTENT_PAUSE",
    );
    assert.equal(f.posts.length, 1);
    other.close();
  }
});

test("success without matching remote state is unknown; manual resolution preserves pause", async () => {
  const f = fixture();
  f.hooks.post = () => {
    f.hooks.public = true;
    return response({});
  };
  await rejects(
    f.service.platformWrite("favorites", f.favoriteArgs),
    "WRITE_RESULT_UNKNOWN",
  );
  const pending = f.state((db) => db.getControl("write:pending"));
  assert.equal(
    resolveUnknown(f.config, pending.id, "applied").pausePreserved,
    true,
  );
  assert.ok(f.state((db) => db.getControl("pause")));
  assert.equal(
    f.state((db) => db.getControl("write:pending")),
    null,
  );
  resumeWrites(f.config);
  assert.equal(
    f.state((db) => db.getControl("pause")),
    null,
  );
  assert.ok(f.service.store.getControl("pause"));
  f.service.close();
});

test("history uses trusted confirmed progress and verifies remote history without regressing it", async () => {
  const f = fixture();
  await rejects(
    f.service.platformWrite("history", {
      readingId: f.reading.id,
      consumptionId: "fake",
    }),
    "CONSUMPTION_REQUIRED",
  );
  assert.equal(f.posts.length, 0);
  assert.throws(() => f.service.confirmConsumption(f.reading.id, -1));
  assert.throws(() => f.service.confirmConsumption(f.reading.id, 61));
  const consumed = f.service.confirmConsumption(f.reading.id, 20);
  const args = { readingId: f.reading.id, consumptionId: consumed.id };
  assert.equal(
    (await f.service.platformWrite("history", args)).result.status,
    "verified",
  );
  assert.equal(
    new URLSearchParams(f.posts[0].options.body).get("progress"),
    "20",
  );
  assert.equal(
    (await f.service.platformWrite("history", args)).result.status,
    "already_recorded",
  );
  const lower = f.service.confirmConsumption(f.reading.id, 10);
  assert.equal(
    (
      await f.service.platformWrite("history", {
        ...args,
        consumptionId: lower.id,
      })
    ).result.status,
    "already_recorded",
  );
  assert.equal(f.posts.length, 1);
  f.service.close();
});

test("account mutex spans local profiles; a contending request does not pause the owner", async () => {
  const f = fixture();
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  let entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  f.hooks.before = async (url) => {
    if (url.pathname.endsWith("/list-all")) {
      entered();
      await wait;
    }
  };
  const running = f.service.platformWrite("favorites", f.favoriteArgs);
  await ready;
  const other = new Service(
    { ...f.config, dataDir: join(f.config.dataDir, "another-profile") },
    { fetcher: f.service.fetcher },
  );
  const id = other.store.saveReading({ ...f.reading }).id;
  await rejects(
    other.platformWrite("favorites", { ...f.favoriteArgs, readingId: id }),
    "TASK_BUSY",
  );
  assert.equal(
    f.state((db) => db.getControl("pause")),
    null,
  );
  release();
  assert.equal((await running).result.status, "verified");
  assert.equal(f.posts.length, 1);
  other.close();
  f.service.close();
});

test("cancellation before dispatch sends no POST; cancellation after dispatch preserves unknown intent", async () => {
  for (const after of [false, true]) {
    const f = fixture(),
      controller = new AbortController();
    if (after)
      f.hooks.post = () => {
        controller.abort();
        return response({});
      };
    else
      f.hooks.before = (url) => {
        if (url.pathname.endsWith("/list-all")) controller.abort();
      };
    await rejects(
      f.service.platformWrite("favorites", f.favoriteArgs, controller.signal),
      after ? "WRITE_RESULT_UNKNOWN" : "CANCELLED",
    );
    assert.equal(f.posts.length, after ? 1 : 0);
    assert.equal(!!f.state((db) => db.getControl("write:pending")), after);
    f.service.close();
  }
});

test("a recovered process-exit intent blocks sending and survives human risk resume", async () => {
  const f = fixture();
  f.state((db) => {
    const id = db.start();
    db.db.prepare("UPDATE tasks SET pid=2147483647 WHERE id=?").run(id);
    db.setControl("write:pending", {
      id: "synthetic-crash-operation",
      status: "pending",
      kind: "favorites",
    });
  });
  await rejects(
    f.service.platformWrite("favorites", f.favoriteArgs),
    "WRITE_RESULT_UNKNOWN",
  );
  assert.equal(f.posts.length, 0);
  assert.throws(
    () => resumeWrites(f.config),
    (e) => e.code === "WRITE_RESULT_UNKNOWN",
  );
  assert.equal(
    f.state((db) => db.getControl("write:pending")).id,
    "synthetic-crash-operation",
  );
  f.service.close();
});

test("writer rejects model-supplied force or paths and obeys request budget", async () => {
  const f = fixture();
  await rejects(
    f.service.platformWrite("favorites", { ...f.favoriteArgs, force: true }),
    "UNKNOWN_PARAMETER",
  );
  assert.equal(f.calls.length, 0);
  f.service.limits.requests = 2;
  await rejects(
    f.service.platformWrite("favorites", f.favoriteArgs),
    "REQUESTS_BUDGET",
  );
  assert.equal(f.posts.length, 0);
  f.service.close();
});

function interaction(kind) {
  const f = fixture();
  const key = kind === "likes" ? "enableLikeWrites" : "enableCoinWrites";
  f.config[key] = f.service.config[key] = true;
  f.args = { readingId: f.reading.id };
  return f;
}

test("all sixteen independent switch combinations register correctly and never expose comments", async () => {
  for (let mask = 0; mask < 16; mask++) {
    const f = fixture(),
      tools = new Map();
    let dispose;
    const config = { ...f.config };
    [
      "enableHistoryWrites",
      "enableFavoriteWrites",
      "enableLikeWrites",
      "enableCoinWrites",
    ].forEach((key, bit) => (config[key] = !!(mask & (1 << bit))));
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
      { ...config, enableDailyFetching: false },
    );
    const expected = 13 + mask.toString(2).replaceAll("0", "").length;
    assert.equal(tools.size, expected);
    assert.ok(
      ![...tools.keys()].some((n) =>
        /comment|reply|publish|resume|consumed/.test(n),
      ),
    );
    const status = JSON.parse(
      await tools.get("bili_humanism_status").execute({}, {}),
    );
    assert.equal(status.platformWriteTools.length, expected - 13);
    for (const key of ["like", "coin"]) {
      if (!tools.has("bili_humanism_" + key)) continue;
      const result = JSON.parse(
        await tools
          .get("bili_humanism_" + key)
          .execute({ readingId: f.reading.id, force: true }, {}),
      );
      assert.equal(result.error, "UNKNOWN_PARAMETER");
    }
    assert.equal(f.calls.length, 0);
    dispose();
    f.service.close();
  }
});

test("like and coin switches, scoped grants and original device cookie are required independently", async () => {
  for (const kind of ["likes", "coins"]) {
    for (const mode of ["switch", "grant", "device", "expired"]) {
      const f = interaction(kind);
      if (mode === "switch")
        f.service.config[
          kind === "likes" ? "enableLikeWrites" : "enableCoinWrites"
        ] = false;
      if (mode === "grant") f.policy[kind].enabled = false;
      if (mode === "expired") f.policy.expiresAt = "2000-01-01T00:00:00Z";
      if (mode === "device")
        writeFileSync(
          f.config.credentialPath,
          JSON.stringify({
            sessdata: "synthetic-session",
            bili_jct: "a".repeat(32),
          }),
        );
      f.save();
      await assert.rejects(f.service.platformWrite(kind, f.args));
      assert.equal(f.calls.length, 0);
      f.service.close();
    }
  }
});

test("likes are add-only and durable dedupe survives stale recent-like API and a new profile", async () => {
  const f = interaction("likes");
  assert.equal(
    (await f.service.platformWrite("likes", f.args)).result.status,
    "verified",
  );
  assert.equal(f.posts.length, 1);
  assert.ok(
    f.posts[0].options.headers.Cookie.includes(
      "buvid3=synthetic-existing-device",
    ),
  );
  f.hooks.likeState = 0;
  const other = new Service(
    { ...f.config, dataDir: join(f.config.dataDir, "other") },
    { fetcher: f.service.fetcher },
  );
  const id = other.store.saveReading({ ...f.reading }).id;
  assert.equal(
    (await other.platformWrite("likes", { readingId: id })).result.status,
    "already_recorded",
  );
  await rejects(
    f.service.platformWrite("likes", { ...f.args, action: "remove" }),
    "UNKNOWN_PARAMETER",
  );
  assert.equal(f.posts.length, 1);
  other.close();
  f.service.close();
});

test("coin targets are cumulative and idempotent, only spending the missing amount without a bundled like", async () => {
  const f = interaction("coins");
  assert.equal(
    (await f.service.platformWrite("coins", f.args)).result.status,
    "verified",
  );
  assert.equal(
    (await f.service.platformWrite("coins", f.args)).result.status,
    "already_recorded",
  );
  f.cool();
  assert.equal(
    (await f.service.platformWrite("coins", { ...f.args, totalCoins: 2 }))
      .result.status,
    "verified",
  );
  assert.equal(
    (await f.service.platformWrite("coins", { ...f.args, totalCoins: 2 }))
      .result.status,
    "already_recorded",
  );
  assert.equal(f.posts.length, 2);
  assert.deepEqual(
    f.posts.map((p) => new URLSearchParams(p.options.body).get("multiply")),
    ["1", "1"],
  );
  assert.ok(
    f.posts.every(
      (p) => new URLSearchParams(p.options.body).get("select_like") === "0",
    ),
  );
  assert.ok(
    f.posts.every((p) => p.url.pathname === "/x/web-interface/coin/add"),
  );
  assert.equal(
    f.state((db) => db.getControl("coin-budget:synthetic-grant")),
    2,
  );
  f.service.close();
});

test("coin per-video and cumulative budget bounds reject excess before sending", async () => {
  for (const mode of ["amount", "per-video", "budget", "invalid-policy"]) {
    const f = interaction("coins");
    let args = f.args;
    if (mode === "amount") args = { ...args, totalCoins: 3 };
    if (mode === "per-video") {
      f.policy.coins.maxPerVideo = 1;
      args = { ...args, totalCoins: 2 };
    }
    if (mode === "budget")
      f.state((db) => db.setControl("coin-budget:synthetic-grant", 2));
    if (mode === "invalid-policy") f.policy.coins.maxCoins = 0;
    f.save();
    await assert.rejects(f.service.platformWrite("coins", args));
    assert.equal(f.posts.length, 0);
    f.service.close();
  }
});

test("like and coin revocation in preflight, wrong accounts and changed device cookies never send", async () => {
  for (const kind of ["likes", "coins"]) {
    for (const mode of ["revoke", "account", "device"]) {
      const f = interaction(kind);
      if (mode === "account") {
        f.policy.accountId = "124";
        f.save();
      } else
        f.hooks.before = (url) => {
          if (
            !url.pathname.endsWith(
              kind === "likes" ? "/has/like" : "/archive/coins",
            )
          )
            return;
          if (mode === "revoke") {
            f.policy[kind].enabled = false;
            f.save();
          } else
            writeFileSync(
              f.config.credentialPath,
              JSON.stringify({
                sessdata: "synthetic-session",
                bili_jct: "a".repeat(32),
                buvid3: "different-device",
              }),
            );
        };
      await assert.rejects(f.service.platformWrite(kind, f.args));
      assert.equal(f.posts.length, 0);
      f.service.close();
    }
  }
});

test("unknown coin outcome reserves spend, never retries and human resolution records the target", async () => {
  const f = interaction("coins");
  f.hooks.post = () => {
    throw new Error("synthetic timeout");
  };
  await rejects(
    f.service.platformWrite("coins", f.args),
    "WRITE_RESULT_UNKNOWN",
  );
  assert.equal(f.posts.length, 1);
  assert.equal(
    f.state((db) => db.getControl("coin-budget:synthetic-grant")),
    1,
  );
  await rejects(f.service.platformWrite("coins", f.args), "PERSISTENT_PAUSE");
  const pending = f.state((db) => db.getControl("write:pending"));
  assert.equal(pending.coins, 1);
  assert.equal(pending.targetCoins, 1);
  resolveUnknown(f.config, pending.id, "applied");
  assert.equal(
    f.state((db) => db.getControl("coins:" + bv)),
    1,
  );
  assert.ok(f.state((db) => db.getControl("pause")));
  assert.equal(f.posts.length, 1);
  f.service.close();
});

test("like and coin remote receipt mismatches persist pause instead of claiming success", async () => {
  for (const kind of ["likes", "coins"]) {
    const f = interaction(kind);
    f.hooks.post = () => {
      if (kind === "likes") f.hooks.likeState = 0;
      else f.hooks.coinState = 0;
      return response({});
    };
    await rejects(
      f.service.platformWrite(kind, f.args),
      "WRITE_RESULT_UNKNOWN",
    );
    assert.ok(f.state((db) => db.getControl("write:pending")));
    assert.equal(f.posts.length, 1);
    f.service.close();
  }
});

test("comments are rejected by service and transport even when every allowed switch is open", async () => {
  const f = interaction("likes");
  f.service.config.enableCoinWrites = true;
  await rejects(
    f.service.platformWrite("comments", {
      readingId: f.reading.id,
      text: "synthetic text",
    }),
    "WRITE_SCOPE_DENIED",
  );
  const network = new Network(
    f.service.store,
    {
      spend() {},
      remaining() {
        return 1000;
      },
    },
    { fetcher: f.service.fetcher },
  );
  network.beforePost = () => assert.fail("Comment must fail before dispatch");
  await rejects(
    network.request(new URL("https://api.bilibili.com/x/v2/reply/add"), "api", {
      method: "POST",
    }),
    "URL_DENIED",
  );
  assert.equal(f.calls.length, 0);
  f.service.close();
});
