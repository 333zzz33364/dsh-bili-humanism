import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  setupOptions,
  setupMedia,
  doctorMedia,
  managedPaths,
  managedEnvironment,
  pythonFor,
  modelFor,
} from "../lib/media-environment.mjs";
import { Service } from "../lib/service.mjs";

// macOS tmpdir() traverses /var -> /private/var; fixtures use the real root,
// while production noLinks() continues to reject user-supplied symlinks.
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "humanism-setup-")));
function managed(
  dir,
  data = { version: 1, frames: true, asr: true, model: true },
) {
  const paths = managedPaths(dir);
  mkdirSync(dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, "synthetic interpreter placeholder");
  mkdirSync(paths.model, { recursive: true });
  writeFileSync(join(paths.model, "model.bin"), "synthetic model placeholder");
  writeFileSync(paths.manifest, JSON.stringify(data));
  return paths;
}

test("setup arguments are explicit and cannot supply repositories, commands or relative interpreters", () => {
  assert.deepEqual(setupOptions([]), { asr: false, downloadModel: false });
  assert.deepEqual(setupOptions(["--asr", "--download-model"]), {
    asr: true,
    downloadModel: true,
  });
  for (const args of [
    ["--download-model"],
    ["--python", "relative"],
    ["--python"],
    ["--repository", "other"],
    ["--command", "anything"],
  ])
    assert.throws(() => setupOptions(args));
});

test("managed discovery ignores manifest-supplied paths and explicit human overrides retain priority", () => {
  const dir = root(),
    paths = managed(dir, {
      version: 1,
      frames: true,
      asr: true,
      model: true,
      python: "untrusted",
      modelPath: "untrusted",
    });
  const previous = process.env.BILI_HUMANISM_PYTHON;
  delete process.env.BILI_HUMANISM_PYTHON;
  try {
    assert.equal(pythonFor({}, dir), paths.python);
    assert.equal(modelFor({}, dir), paths.model);
    process.env.BILI_HUMANISM_PYTHON = "synthetic-env-python";
    assert.equal(pythonFor({}, dir), "synthetic-env-python");
    assert.equal(
      pythonFor({ pythonPath: "synthetic-config-python" }, dir),
      "synthetic-config-python",
    );
    assert.equal(
      modelFor({ asrModelPath: "synthetic-config-model" }, dir),
      "synthetic-config-model",
    );
  } finally {
    if (previous === undefined) delete process.env.BILI_HUMANISM_PYTHON;
    else process.env.BILI_HUMANISM_PYTHON = previous;
  }
});

test("malformed or oversized setup manifests never enable a managed runtime", () => {
  const dir = root(),
    paths = managed(dir);
  writeFileSync(paths.manifest, "{broken");
  assert.equal(managedEnvironment(dir), null);
  writeFileSync(paths.manifest, " ".repeat(5000));
  assert.equal(managedEnvironment(dir), null);
});

test("failed binary dependency installation does not publish readiness and releases its lock", async () => {
  const dir = root(),
    paths = managedPaths(dir),
    calls = [];
  const runner = async (_python, args) => {
    calls.push(args);
    if (args.includes("-c"))
      return {
        code: 0,
        output: args.at(-1).includes("base_prefix")
          ? JSON.stringify({
              prefix: join(paths.directory, "venv"),
              base: join(dir, "synthetic-base-python"),
            })
          : "[3,12]",
      };
    if (args.includes("venv")) {
      mkdirSync(dirname(paths.python), { recursive: true });
      writeFileSync(paths.python, "synthetic");
      return { code: 0, output: "" };
    }
    return { code: 1, output: "" };
  };
  await assert.rejects(
    setupMedia({ dataDir: dir }, setupOptions([]), { runner }),
    (e) => e.code === "MEDIA_DEPENDENCY_INSTALL_FAILED",
  );
  assert.ok(
    calls.some(
      (args) =>
        args.includes("--only-binary=:all:") && args.includes("--isolated"),
    ),
  );
  assert.equal(existsSync(paths.manifest), false);
  assert.equal(existsSync(join(paths.directory, "setup.lock")), false);
});

test("doctor distinguishes missing ASR weights from frame dependencies and makes no service or platform calls", async () => {
  const calls = [];
  const result = await doctorMedia(
    { dataDir: root() },
    async (_python, args) => {
      calls.push(args);
      return {
        code: args[0].endsWith("frame_environment.py") ? 0 : 2,
        output: JSON.stringify({
          status: args[0].endsWith("frame_environment.py")
            ? "ready"
            : "model_missing",
        }),
      };
    },
  );
  assert.equal(result.frames.status, "ready");
  assert.equal(result.asr.status, "model_missing");
  assert.equal(result.platformRequests, 0);
  assert.equal(calls.length, 2);
  assert.match(result.hostVision, /text-only/);
});

test("ASR rejects a missing model with a specific diagnosis before spawning or network access", async () => {
  const service = new Service(
    { dataDir: root() },
    {
      spawn: () => assert.fail("Unexpected subprocess"),
      fetcher: () => assert.fail("Unexpected platform request"),
    },
  );
  try {
    const reading = service.store.saveReading({
      bvid: "BV0000000001",
      cid: 1,
      page: 1,
      duration: 3,
      title: "Synthetic",
      route: "A1",
      segments: [],
      coverage: {},
    });
    await assert.rejects(
      service.localMedia("asr", reading.id, "synthetic.wav"),
      (e) => e.code === "ASR_MODEL_MISSING",
    );
  } finally {
    service.close();
  }
});
