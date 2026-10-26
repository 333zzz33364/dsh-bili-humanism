import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../lib/store.mjs";
import { Budget } from "../lib/budget.mjs";
import { Network } from "../lib/network.mjs";
import { Service } from "../lib/service.mjs";
import { safeError } from "../lib/errors.mjs";
import { apply } from "../index.js";

const api = "https://api.bilibili.com/x/player/playurl?bvid=BV0000000001&cid=7";
const media =
  "https://synthetic.bilivideo.com/audio.m4s?signature=SYNTHETIC_PRIVATE";
const json = (v) => new Response(JSON.stringify(v));
const temp = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "humanism-diagnostics-")));
function fixture(t, fetcher, authenticated = false) {
  const root = temp(),
    store = new Store(root),
    id = store.start();
  t.after(() => store.close());
  const credentialPath = join(root, "synthetic-credential.json");
  if (authenticated)
    writeFileSync(credentialPath, '{"sessdata":"SYNTHETIC_SECRET"}');
  return {
    store,
    network: new Network(
      store,
      new Budget(store, id, { requests: 12, wallMs: 90000 }),
      { fetcher, ...(authenticated ? { credentialPath } : {}) },
    ),
  };
}

test("unavailable API hints reflect absent credentials without asserting a cause or weakening pauses", async (t) => {
  for (const authenticated of [false, true]) {
    const f = fixture(
      t,
      async () =>
        json({ code: -104, message: "UNTRUSTED_PRIVATE platform text" }),
      authenticated,
    );
    await assert.rejects(f.network.get(api), (e) => {
      const report = safeError(e);
      assert.equal(report.error, "API_UNAVAILABLE");
      if (!authenticated) {
        assert.match(report.message, /No read credential was loaded/);
        assert.match(report.message, /BILI_HUMANISM_CREDENTIAL_FILE/);
        assert.match(report.message, /not establish/);
      } else
        assert.doesNotMatch(report.message, /No read credential was loaded/);
      assert.doesNotMatch(
        JSON.stringify(report),
        /SYNTHETIC_SECRET|UNTRUSTED_PRIVATE/,
      );
      return true;
    });
    assert.equal(f.store.getControl("pause"), null);
  }
  const risk = fixture(t, async () =>
    json({ code: -101, message: "UNTRUSTED_PRIVATE" }),
  );
  await assert.rejects(
    risk.network.get(api),
    (e) => e.code === "CREDENTIAL_EXPIRED",
  );
  assert.equal(risk.store.getControl("pause").reason, "API_-101");
});

test("response size diagnostics distinguish declared bytes and a streamed lower bound from duration", async (t) => {
  for (const [kind, url, limit] of [
    ["media", media, 33554432],
    ["api", api, 4194304],
  ]) {
    const f = fixture(
      t,
      async () =>
        new Response("synthetic", {
          headers: { "content-length": String(limit + 1) },
        }),
    );
    await assert.rejects(f.network.get(url, kind), (e) => {
      const report = safeError(e);
      assert.equal(report.error, "RESPONSE_TOO_LARGE");
      assert.ok(
        report.message.includes(String(limit)) &&
          report.message.includes(String(limit + 1)),
      );
      assert.match(report.message, /Content-Length/);
      assert.match(report.message, /not a source-duration/);
      assert.doesNotMatch(
        JSON.stringify(report),
        /signature|SYNTHETIC_PRIVATE|https:/,
      );
      return true;
    });
  }
  const streamed = fixture(
    t,
    async () => new Response(new Uint8Array(4194305)),
  );
  await assert.rejects(streamed.network.get(api), (e) => {
    assert.equal(e.code, "RESPONSE_TOO_LARGE");
    assert.match(e.message, /4194304/);
    assert.match(e.message, /at least 4194305/);
    return true;
  });
});

test("service and CLI status show effective request and wall budgets alongside fixed response byte limits", (t) => {
  const root = temp(),
    config = {
      dataDir: join(root, "ledger"),
      limits: { requests: 7, wallMs: 45000 },
    };
  const service = new Service(config);
  const expected = {
    mediaResponseBytes: 33554432,
    jsonResponseBytes: 4194304,
    taskRequests: 7,
    taskWallMs: 45000,
  };
  assert.equal(service.status().media.maxSourceSeconds, null);
  for (const [key, value] of Object.entries(expected))
    assert.equal(service.status().media[key], value);
  service.close();
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ ...config, maxMediaSeconds: 1200 }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("BILI_HUMANISM_"),
    ),
  );
  const result = spawnSync(process.execPath, ["bin/cli.mjs", "status"], {
    cwd: new URL("..", import.meta.url),
    env: { ...env, BILI_HUMANISM_CONFIG_FILE: path },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.media.maxSourceSeconds, 1200);
  for (const [key, value] of Object.entries(expected))
    assert.equal(status.media[key], value);
  assert.deepEqual(status.platformWriteTools, []);
});

test("registered read tool and audio CLI expose the same safe anonymous and oversized response diagnostics", async (t) => {
  const root = temp(),
    dataDir = join(root, "ledger"),
    store = new Store(dataDir);
  const reading = store.saveReading({
    bvid: "BV0000000001",
    cid: 7,
    page: 1,
    duration: 1275,
    route: "none",
    segments: [],
    coverage: { state: "unknown" },
  });
  store.close();
  const preload = join(root, "synthetic-fetch.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.bilibili.com" && u.pathname === "/x/player/playurl") {
      if (process.env.SYNTHETIC_DIAGNOSTIC_MODE === "size") return new Response(JSON.stringify({ code: 0, data: { dash: { audio: [{ bandwidth: 100, baseUrl: "https://synthetic.bilivideo.com/audio.m4s" }] } } }));
      return new Response(JSON.stringify({ code: -104, message: "UNTRUSTED_PRIVATE" }));
    }
    if (u.hostname === "synthetic.bilivideo.com") return new Response("synthetic", { headers: { "content-length": "33554433" } });
    throw new Error("Unexpected synthetic URL");
  };`,
  );
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    json({ code: -104, message: "UNTRUSTED_PRIVATE" });
  const tools = new Map();
  let dispose;
  apply(
    {
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir },
  );
  let report;
  try {
    report = JSON.parse(
      await tools
        .get("bili_humanism_read")
        .execute({ video: "BV0000000001" }, {}),
    );
  } finally {
    dispose();
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("BILI_HUMANISM_"),
    ),
  );
  for (const mode of ["anonymous", "size"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "bin/cli.mjs",
        "audio",
        reading.id,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...env,
          BILI_HUMANISM_HOME: dataDir,
          SYNTHETIC_DIAGNOSTIC_MODE: mode,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stdout);
    const output = JSON.parse(result.stderr.trim());
    if (mode === "anonymous") {
      assert.deepEqual(output, report);
      assert.match(output.message, /BILI_HUMANISM_CREDENTIAL_FILE/);
    } else {
      assert.equal(output.error, "RESPONSE_TOO_LARGE");
      assert.match(output.message, /33554432/);
      assert.match(output.message, /33554433/);
    }
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNTRUSTED_PRIVATE|signature|SYNTHETIC_SECRET/,
    );
  }
});
