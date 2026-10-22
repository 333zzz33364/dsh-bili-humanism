import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Fault, need } from "./errors.mjs";
import { atomic } from "./store.mjs";
import { noLinks } from "./visual-media.mjs";

const script = (name) =>
  fileURLToPath(new URL("../scripts/" + name, import.meta.url));
export const mediaRoot = (config = {}) =>
  resolve(
    config.dataDir ||
      join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-humanism"),
  );
export const managedPaths = (root) => {
  const directory = join(root, "media-runtime");
  return {
    directory,
    python: join(
      directory,
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
    model: join(directory, "faster-whisper-small"),
    manifest: join(directory, "environment.json"),
  };
};

export function managedEnvironment(root) {
  const paths = managedPaths(root);
  try {
    noLinks(paths.manifest);
    need(lstatSync(paths.manifest).size < 4096, "INVALID_MEDIA_ENVIRONMENT");
    const data = JSON.parse(readFileSync(paths.manifest, "utf8"));
    need(
      data.version === 1 && data.frames === true,
      "INVALID_MEDIA_ENVIRONMENT",
    );
    noLinks(paths.directory);
    need(existsSync(paths.python), "INVALID_MEDIA_ENVIRONMENT");
    // venv/bin/python is normally a symlink on POSIX; its target is selected by venv.
    return {
      ...paths,
      asr: data.asr === true,
      modelReady:
        data.model === true && existsSync(join(paths.model, "model.bin")),
    };
  } catch {
    return null;
  }
}

export function pythonFor(config, root) {
  return (
    config.pythonPath ||
    process.env.BILI_HUMANISM_PYTHON ||
    managedEnvironment(root)?.python ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

export function modelFor(config, root) {
  return (
    config.asrModelPath ||
    (managedEnvironment(root)?.modelReady ? managedPaths(root).model : "")
  );
}

export function mediaEnvironmentStatus(config, root) {
  const managed = managedEnvironment(root);
  return {
    interpreterSource: config.pythonPath
      ? "pythonPath"
      : process.env.BILI_HUMANISM_PYTHON
        ? "environment"
        : managed
          ? "managed"
          : "system",
    managedInstalled: Boolean(managed),
    asrModelConfigured: Boolean(modelFor(config, root)),
    dependencies:
      "Use the local doctor command to verify actual imports and model readiness.",
    setup: "bili-humanism setup-media [--asr --download-model]",
    hostVision:
      "Requires an image-capable host model and attachments. Installing Python packages cannot enable image input in a text-only model.",
  };
}

export function runEnvironment(
  python,
  args,
  { timeout = 120000, env = process.env } = {},
) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(python, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        PYTHONUTF8: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      },
    });
    let output = Buffer.alloc(0),
      overflow = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > 65536) {
        overflow = true;
        child.kill();
      } else output = Buffer.concat([output, chunk]);
    });
    // Suppress raw pip/loader/network errors, which may contain user paths or URLs.
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Fault("PYTHON_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || overflow)
        reject(
          new Fault(
            timedOut ? "MEDIA_SETUP_TIMEOUT" : "MEDIA_SETUP_OUTPUT_LIMIT",
          ),
        );
      else resolveRun({ code, output: output.toString("utf8") });
    });
  });
}

export async function doctorMedia(config = {}, runner = runEnvironment) {
  const root = mediaRoot(config),
    python = pythonFor(config, root),
    model = modelFor(config, root);
  const probe = async (name, args) => {
    try {
      const result = await runner(python, [script(name), ...args]);
      return JSON.parse(result.output);
    } catch (error) {
      return {
        status: "unavailable",
        error: error.code || "INVALID_DIAGNOSTIC",
      };
    }
  };
  const frames = await probe("frame_environment.py", ["doctor"]);
  const asr = await probe("asr_environment.py", [
    "doctor",
    ...(model ? ["--model", model] : []),
  ]);
  return {
    ...mediaEnvironmentStatus(config, root),
    python,
    asrModelPath: model || null,
    frames,
    asr,
    platformRequests: 0,
    modelCalls: 0,
  };
}

export function setupOptions(args) {
  const result = { asr: false, downloadModel: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--asr") result.asr = true;
    else if (arg === "--download-model") result.downloadModel = true;
    else if (arg === "--python") {
      need(
        !result.python &&
          typeof args[i + 1] === "string" &&
          isAbsolute(args[i + 1]),
        "INVALID_SETUP_ARGUMENT",
      );
      result.python = args[++i];
    } else throw new Fault("INVALID_SETUP_ARGUMENT");
  }
  need(!result.downloadModel || result.asr, "ASR_SETUP_REQUIRED");
  return result;
}

export async function setupMedia(
  config,
  options,
  { runner = runEnvironment, progress = () => {} } = {},
) {
  const root = mediaRoot(config),
    paths = managedPaths(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  noLinks(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  noLinks(paths.directory);
  const lock = join(paths.directory, "setup.lock");
  let handle;
  try {
    handle = openSync(lock, "wx", 0o600);
  } catch {
    throw new Fault(
      "MEDIA_SETUP_BUSY",
      "Media setup is already running. If a previous installer was interrupted, inspect the private media-runtime/setup.lock before retrying.",
    );
  }
  try {
    const explicit =
      options.python || config.pythonPath || process.env.BILI_HUMANISM_PYTHON;
    const bundled = join(
      process.env.DSH_HOME || join(homedir(), ".dsh"),
      "dsh-runtimes/dsh-primary-runtime/dependencies/python",
      process.platform === "win32" ? "python.exe" : "bin/python3",
    );
    const choices = explicit
      ? [explicit]
      : [
          ...(existsSync(bundled) ? [bundled] : []),
          ...(process.platform === "win32"
            ? ["python", "py"]
            : ["python3", "python"]),
        ];
    let base;
    for (const choice of choices) {
      try {
        const probe = await runner(choice, [
          "-I",
          "-c",
          "import sys,json;print(json.dumps(list(sys.version_info[:2])))",
        ]);
        const version = JSON.parse(probe.output);
        if (probe.code === 0 && version[0] === 3 && version[1] >= 10) {
          base = choice;
          break;
        }
      } catch {
        /* Try another installed interpreter, never install system Python. */
      }
    }
    need(base, "PYTHON_UNAVAILABLE");
    if (!existsSync(paths.python)) {
      progress("create_isolated_environment");
      if (existsSync(join(paths.directory, "venv")))
        noLinks(join(paths.directory, "venv"));
      const result = await runner(base, [
        "-I",
        "-m",
        "venv",
        join(paths.directory, "venv"),
      ]);
      need(result.code === 0, "MEDIA_VENV_FAILED");
    }
    noLinks(join(paths.directory, "venv"));
    const isolated = await runner(paths.python, [
      "-I",
      "-c",
      "import sys,json;print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix}))",
    ]);
    const isolation = JSON.parse(isolated.output);
    need(
      isolated.code === 0 &&
        resolve(isolation.prefix) === resolve(join(paths.directory, "venv")) &&
        resolve(isolation.base) !== resolve(isolation.prefix),
      "MEDIA_VENV_NOT_ISOLATED",
    );
    progress("install_pinned_binary_dependencies");
    const args = [
      "-I",
      "-m",
      "pip",
      "--isolated",
      "install",
      "--quiet",
      "--no-input",
      "--disable-pip-version-check",
      "--only-binary=:all:",
      "--index-url",
      "https://pypi.org/simple",
      "-r",
      script("requirements-frames.txt"),
    ];
    if (options.asr) args.push("-r", script("requirements-asr.txt"));
    const installed = await runner(paths.python, args, { timeout: 900000 });
    need(installed.code === 0, "MEDIA_DEPENDENCY_INSTALL_FAILED");
    const frame = await runner(paths.python, [
      script("frame_environment.py"),
      "smoke",
    ]);
    need(
      frame.code === 0 && JSON.parse(frame.output).status === "passed",
      "MEDIA_FRAME_SMOKE_FAILED",
    );
    if (options.asr) {
      const checked = await runner(paths.python, [
        script("asr_environment.py"),
        "doctor",
      ]);
      need(
        ["ready", "model_missing"].includes(JSON.parse(checked.output).status),
        "ASR_DEPENDENCIES_UNAVAILABLE",
      );
    }
    let modelReady = managedEnvironment(root)?.modelReady || false;
    if (options.downloadModel) {
      progress("download_and_verify_small_model_486212372_bytes");
      if (existsSync(paths.model)) noLinks(paths.model);
      const downloaded = await runner(
        paths.python,
        [script("asr_environment.py"), "download", "--model", paths.model],
        { timeout: 1860000 },
      );
      need(downloaded.code === 0, "ASR_MODEL_DOWNLOAD_FAILED");
      progress("load_cpu_asr_model");
      const loaded = await runner(paths.python, [
        script("asr_environment.py"),
        "load",
        "--model",
        paths.model,
      ]);
      need(
        loaded.code === 0 &&
          JSON.parse(loaded.output).model === "loaded_cpu_int8",
        "ASR_MODEL_LOAD_FAILED",
      );
      modelReady = true;
    }
    const previous = managedEnvironment(root);
    atomic(
      paths.manifest,
      JSON.stringify({
        version: 1,
        frames: true,
        asr: options.asr || previous?.asr || false,
        model: modelReady,
      }) + "\n",
    );
    return {
      status: "ready",
      managedPython: paths.python,
      asrModelPath: modelReady ? paths.model : null,
      modelDownloadRequested: options.downloadModel,
      note: "The plugin automatically discovers this environment for the same dataDir. Explicit pythonPath/environment overrides still take priority; doctor verifies the effective interpreter. Image understanding requires a compatible host model.",
    };
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}
