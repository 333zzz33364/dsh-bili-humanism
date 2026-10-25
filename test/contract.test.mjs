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
      effect(setup) {
        dispose = setup();
      },
    },
    { dataDir: mkdtempSync(join(tmpdir(), "humanism-contract-")) },
  );
  assert.equal(tools.size, 14);
  assert.ok(tools.has("bili_humanism_personality"));
  const status = JSON.parse(
    await tools.get("bili_humanism_status").execute({}, {}),
  );
  assert.deepEqual(status.platformWriteTools, []);
  assert.equal(status.scheduled, false);
  assert.equal(status.dailyFetching.enabled, false);
  assert.equal(status.personalityShadow.enabled, false);
  assert.equal(status.personalityShadow.experimental, true);
  assert.equal(status.personalityShadow.activePersonalityWrites, false);
  assert.equal(status.dailyFetching.nextAt, null);
  assert.equal(status.dailyFetching.start, "21:30");
  assert.equal(status.dailyFetching.end, "22:00");
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
    guide.includes("【实验性】") && guide.includes("enablePersonalityShadow"),
  );
  assert.ok(
    ![...tools.keys()].some((n) => /publish|comment|like|resume/.test(n)),
  );
  dispose();
});
