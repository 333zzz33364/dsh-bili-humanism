import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Budget } from "../lib/budget.mjs";
import { Network } from "../lib/network.mjs";
import { Fault, safeError } from "../lib/errors.mjs";

const api = "https://api.bilibili.com/x/web-interface/view?bvid=BV0000000001";
const json = (value = { code: 0, data: {} }) =>
  new Response(JSON.stringify(value));
function fixture(t, fetcher, { requests = 12, signal, credentials } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "humanism-network-")));
  const store = new Store(dir),
    id = store.start();
  t.after(() => store.close());
  const budget = new Budget(store, id, { requests, wallMs: 90000 }, signal);
  let credentialPath;
  if (credentials) {
    credentialPath = join(dir, "credentials.json");
    writeFileSync(credentialPath, JSON.stringify(credentials));
  }
  return {
    store,
    budget,
    network: new Network(store, budget, { fetcher, credentialPath }),
  };
}

test("GET transport failures retry at most three times with per-attempt request accounting and guards", async (t) => {
  let calls = 0,
    guards = 0;
  const f = fixture(t, async () => {
    if (++calls < 3) throw new Error("synthetic reset");
    return json();
  });
  f.network.guard = () => guards++;
  assert.equal((await f.network.get(api)).code, 0);
  assert.equal(calls, 3);
  assert.equal(guards, 3);
  assert.equal(f.budget.requests, 3);
});

test("exhausted GET retries keep raw error messages and signed URLs out of errors", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    throw new Error(
      "PRIVATE_SECRET https://synthetic.bilivideo.com/video?signature=PRIVATE",
    );
  });
  await assert.rejects(f.network.get(api), (error) => {
    assert.deepEqual(safeError(error), {
      error: "NETWORK_FAILED",
      message: "NETWORK_FAILED",
    });
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(f.budget.requests, 3);
});

test("GET retries stop at the shared request budget", async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    async () => {
      calls++;
      throw new Error("synthetic");
    },
    { requests: 2 },
  );
  await assert.rejects(
    f.network.get(api),
    (error) => error.code === "REQUESTS_BUDGET",
  );
  assert.equal(calls, 2);
  assert.equal(f.budget.requests, 2);
});

test("cancellation, durable pause and revoked guards stop a failed GET before its next dispatch", async (t) => {
  for (const mode of ["cancel", "pause", "guard", "wall"]) {
    const controller = new AbortController();
    let calls = 0,
      guards = 0;
    const f = fixture(
      t,
      async () => {
        calls++;
        if (mode === "cancel") controller.abort();
        if (mode === "pause") f.store.pause("SYNTHETIC_RISK");
        if (mode === "wall") f.budget.started -= 100000;
        throw new Error("synthetic reset");
      },
      { signal: controller.signal },
    );
    f.network.guard = () => {
      if (++guards === 2) throw new Fault("WRITE_DISABLED");
    };
    const expected = {
      cancel: "CANCELLED",
      pause: "PERSISTENT_PAUSE",
      guard: "WRITE_DISABLED",
      wall: "WALL_BUDGET",
    }[mode];
    await assert.rejects(
      f.network.get(api),
      (error) => error.code === expected,
    );
    assert.equal(calls, 1);
  }
});

test("HTTP risk, redirects and API challenges never enter transport retries", async (t) => {
  for (const status of [401, 403, 412, 429, 302, 500]) {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return new Response("", { status });
    });
    await assert.rejects(
      f.network.get(api),
      (error) =>
        error.code ===
        (status < 500 && status !== 302 ? "PLATFORM_PAUSED" : "HTTP_FAILED"),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return json({ code: -352, message: "synthetic" });
  });
  await assert.rejects(
    f.network.get(api),
    (error) => error.code === "PLATFORM_PAUSED",
  );
  assert.equal(calls, 1);
  assert.ok(f.store.getControl("pause"));
});

test("POST transport failure never retries or repeats its durable send hook", async (t) => {
  let calls = 0,
    hooks = 0;
  const f = fixture(t, async () => {
    calls++;
    throw new Error("synthetic reset");
  });
  f.network.beforePost = () => hooks++;
  await assert.rejects(
    f.network.request(
      new URL("https://api.bilibili.com/x/web-interface/archive/like"),
      "api",
      { method: "POST", body: new URLSearchParams({ like: "1" }) },
    ),
    (error) => error.code === "NETWORK_FAILED",
  );
  assert.equal(calls, 1);
  assert.equal(hooks, 1);
  assert.equal(f.budget.requests, 1);
});

test("existing human-provided device cookie is sent only on API GETs; POST and CDN isolation remain", async (t) => {
  const calls = [];
  const f = fixture(
    t,
    async (url, options) => {
      calls.push({ url, options });
      return json();
    },
    {
      credentials: {
        sessdata: "synthetic-session",
        buvid3: "synthetic-existing-device",
      },
    },
  );
  await f.network.get(api);
  await f.network.get(
    "https://aisubtitle.hdslb.com/synthetic.json",
    "subtitle",
  );
  await f.network.get("https://synthetic.bilivideo.com/video.mp4", "media");
  f.network.beforePost = () => {};
  await f.network.request(
    new URL("https://api.bilibili.com/x/v2/history/report"),
    "api",
    { method: "POST", body: new URLSearchParams() },
  );
  assert.equal(
    calls[0].options.headers.Cookie,
    "SESSDATA=synthetic-session; buvid3=synthetic-existing-device",
  );
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[2].options.headers.Cookie, undefined);
  assert.equal(calls[3].options.headers.Cookie, "SESSDATA=synthetic-session");
  assert.ok(calls.every((call) => call.options.redirect === "manual"));
  assert.equal(calls.length, 4); // No fingerprint-generation or extra setup endpoint.
});

test("malformed optional device credentials fail before a request without exposing their contents", (t) => {
  for (const buvid3 of [
    "PRIVATE;cookie",
    "PRIVATE\r\nHEADER",
    "x".repeat(257),
    123,
    {},
  ]) {
    assert.throws(
      () =>
        fixture(t, () => assert.fail("Unexpected request"), {
          credentials: { sessdata: "synthetic", buvid3 },
        }),
      (error) =>
        error.code === "CREDENTIAL_INVALID" &&
        error.message === "CREDENTIAL_INVALID",
    );
  }
});
