import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../index.js";
test("pinned real DSH defineTool validates every registration and executes guide/status", async () => {
  const tools = new Map();
  let dispose;
  plugin.apply(
    {
      tools: {
        register(t) {
          assert.ok(t.parameters && t.output?.schema);
          assert.ok(!tools.has(t.name));
          tools.set(t.name, t);
        },
      },
      on(event, fn) {
        assert.equal(event, "dispose");
        dispose = fn;
      },
    },
    { dataDir: mkdtempSync(join(tmpdir(), "humanism-contract-")) },
  );
  assert.equal(tools.size, 11);
  assert.ok(tools.has("bili_humanism_personality"));
  const status = JSON.parse(
    await tools.get("bili_humanism_status").execute({}, {}),
  );
  assert.deepEqual(status.platformWriteTools, []);
  assert.equal(status.scheduled, false);
  const injected = JSON.parse(
    await tools
      .get("bili_humanism_read")
      .execute({ video: "BV0000000001", force: true }, {}),
  );
  assert.equal(injected.error, "UNKNOWN_PARAMETER");
  const guide = JSON.parse(
    await tools.get("bili_humanism_guide").execute({}, {}),
  );
  assert.ok(guide.includes("尊严"));
  assert.ok(
    ![...tools.keys()].some((n) => /publish|comment|like|resume/.test(n)),
  );
  dispose();
});
test("host token gate rejects a mutation after the durable session allowance", async () => {
  const tools = new Map();
  let dispose;
  let count = 100;
  const ctx = {
    tools: {
      register(t) {
        tools.set(t.name, t);
      },
    },
    on(_e, fn) {
      dispose = fn;
    },
    get(name) {
      assert.equal(name, "sessionProjections");
      return {
        stateOf() {
          return {
            last: {},
            totals: {
              uncachedInputTokens: count,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
      };
    },
  };
  plugin.apply(ctx, {
    dataDir: mkdtempSync(join(tmpdir(), "humanism-meter-")),
    maxSessionTokens: 60,
  });
  const memory = tools.get("bili_humanism_memory");
  const exec = { agent: { session: { id: "metered-session" } } };
  const body = {
    subject: "self",
    understanding: "first",
    evidence: "local test",
  };
  assert.equal(
    JSON.parse(
      await memory.execute(
        { action: "put", id: "self", json: JSON.stringify(body) },
        exec,
      ),
    ).revision,
    1,
  );
  count = 161;
  assert.equal(
    JSON.parse(
      await memory.execute(
        {
          action: "put",
          id: "self",
          json: JSON.stringify({ ...body, understanding: "should not commit" }),
        },
        exec,
      ),
    ).error,
    "TOKEN_BUDGET",
  );
  const saved = JSON.parse(await memory.execute({ action: "list" }, exec));
  assert.equal(saved[0].body.understanding, "first");
  assert.equal(
    JSON.parse(await memory.execute({ action: "delete", id: "self" }, exec))
      .deleted,
    true,
  );
  dispose();
});
