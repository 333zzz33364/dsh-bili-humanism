import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, atomic } from "./store.mjs";
import { Budget } from "./budget.mjs";
import { Network } from "./network.mjs";
import { readVideo, candidates, coverage, segments } from "./reader.mjs";
import { Fault, need, safeError } from "./errors.mjs";
import {
  temporaryVideo,
  videoTrack,
  cleanupVideo,
  inside,
  noLinks,
  boundedFrameBytes,
} from "./visual-media.mjs";
import { Writer, grant, writeStatus, confirmConsumption } from "./writer.mjs";
import { personality } from "./personality.mjs";
import { fields, exportInbox, readInbox, verifyInbox } from "./inbox.mjs";
import {
  enforceJournalDailyLimit,
  journalDailyStatus,
} from "./journal-policy.mjs";
const defaultLimits = {
  requests: 12,
  candidates: 3,
  asrSeconds: 600,
  wallMs: 90000,
};
export function text(value, max = 12000) {
  need(typeof value === "string" && value.length <= max, "INVALID_TEXT");
  return value.trim();
}
export function noteBody(raw, reading) {
  need(raw && typeof raw === "object" && !Array.isArray(raw), "INVALID_NOTE");
  need(
    Object.keys(raw).every((k) => fields.includes(k) || k === "evidence"),
    "INVALID_NOTE_FIELD",
  );
  const body = Object.fromEntries(fields.map((k) => [k, text(raw[k] || "")]));
  need(body.encounter && body.missing, "NOTE_REQUIRES_ENCOUNTER_AND_LIMITS");
  need(
    Array.isArray(raw.evidence) && raw.evidence.length <= 20,
    "INVALID_EVIDENCE",
  );
  body.evidence = raw.evidence.map((e) => {
    need(
      Number.isFinite(e.at) && e.at >= 0 && e.at <= reading.duration,
      "INVALID_EVIDENCE_TIME",
    );
    return {
      at: e.at,
      claim: text(e.claim, 2000),
      url: reading.url + "&t=" + Math.floor(e.at),
    };
  });
  if (body.facts || body.author_view)
    need(body.evidence.length > 0, "EVIDENCE_REQUIRED");
  return body;
}
export class Service {
  constructor(config = {}, dependencies = {}) {
    need(
      config.pythonPath === undefined ||
        (typeof config.pythonPath === "string" &&
          (!config.pythonPath || isAbsolute(config.pythonPath))),
      "INVALID_PYTHON_PATH",
    );
    this.config = {
      ...config,
      enablePersonalityLearning:
        config.enablePersonalityLearning === undefined
          ? true
          : config.enablePersonalityLearning,
    };
    this.store = new Store(
      config.dataDir ||
        join(process.env.DSH_HOME || join(homedir(), ".dsh"), "bili-humanism"),
    );
    this.limits = { ...defaultLimits, ...config.limits };
    for (const key of Object.keys(defaultLimits))
      need(
        Number.isFinite(this.limits[key]) &&
          this.limits[key] >= 0 &&
          this.limits[key] <= defaultLimits[key],
        "INVALID_LIMIT",
      );
    this.fetcher = dependencies.fetcher || globalThis.fetch;
    this.spawn = dependencies.spawn || spawn;
    this.active = new Set();
  }
  async task(fn, signal) {
    const id = this.store.start();
    const controller = new AbortController();
    this.active.add(controller);
    const budget = new Budget(
      this.store,
      id,
      this.limits,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
    try {
      const network = new Network(this.store, budget, {
        credentialPath: this.config.credentialPath,
        fetcher: this.fetcher,
      });
      const result = await fn(network, budget);
      budget.check();
      this.store.finish(id, "completed");
      return {
        taskId: id,
        result,
        usage: {
          requests: budget.requests,
          candidates: budget.candidates,
          asr_seconds: budget.asr,
          elapsed_ms: Date.now() - budget.started,
          tokens: null,
        },
      };
    } catch (e) {
      this.store.finish(
        id,
        e.code === "CANCELLED" ? "cancelled" : "failed",
        e.code || "INTERNAL_ERROR",
      );
      throw e;
    } finally {
      this.active.delete(controller);
      if (this.closing && this.active.size === 0) this.store.close();
    }
  }
  async read(input, page, signal) {
    return this.task(
      (network) => this.readSource(input, page, network),
      signal,
    );
  }
  async readSource(input, page, network) {
    const reading = await readVideo(input, page, network, this.store);
    const local = !reading.segments.length
      ? this.store.localTranscript(reading)
      : null;
    if (local)
      return {
        ...local,
        cached: reading.cached,
        deduplicated: true,
        reusedLocalSource: true,
        networkSource: {
          route: reading.route,
          cached: reading.cached,
          attempts: reading.attempts,
          coverage: reading.coverage,
        },
      };
    return this.store.saveReading(reading);
  }
  async readVisual(input, page, signal) {
    return this.task(async (network, budget) => {
      const reading = await this.readSource(input, page, network);
      try {
        budget.check();
        const visual = this.store.getControl("visual:" + reading.id)
          ? this.visualFrames(reading.id)
          : await this.prepareVisual(reading, network, budget);
        return { ...reading, visual: { status: "sampled_frames", ...visual } };
      } catch (error) {
        if (
          [
            "CANCELLED",
            "WALL_BUDGET",
            "PERSISTENT_PAUSE",
            "PLATFORM_PAUSED",
            "CREDENTIAL_INVALID",
            "CREDENTIAL_EXPIRED",
            "REQUESTS_BUDGET",
            "CANDIDATES_BUDGET",
          ].includes(error.code)
        )
          throw error;
        return {
          ...reading,
          visual: {
            status: "unavailable",
            ...safeError(error),
            note: "No video images were delivered; text does not establish visual understanding.",
          },
        };
      }
    }, signal);
  }
  async candidates(count = 3, signal) {
    return this.task((network) => candidates(network, count), signal);
  }
  status() {
    const writes = writeStatus(this.config);
    return {
      ...this.store.status(),
      journals: journalDailyStatus(this.store),
      platformWriteTools: writes.platformWriteTools,
      writes,
    };
  }
  async platformWrite(kind, args, signal) {
    need(
      ["history", "favorites", "likes", "coins"].includes(kind),
      "WRITE_SCOPE_DENIED",
    );
    grant(this.config, kind);
    return this.task(
      (network) => new Writer(this.config, this.store, network).run(kind, args),
      signal,
    );
  }
  confirmConsumption(readingId, seconds) {
    return confirmConsumption(this.store, readingId, seconds);
  }
  personality(action, args = {}) {
    return personality(
      this.store,
      action,
      args,
      this.config.enablePersonalityLearning === true,
    );
  }
  journal(readingId, raw) {
    const reading = this.store.reading(readingId);
    const body = noteBody(raw, reading);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT id FROM notes WHERE reading_id=? AND body=? ORDER BY created,id LIMIT 1",
        )
        .get(readingId, JSON.stringify(body));
      if (existing) {
        verifyInbox(this.store);
        return {
          id: existing.id,
          readingId,
          status: "local_reviewable_draft",
          path: join(this.store.root, "inbox.md"),
          deduplicated: true,
        };
      }
      const created = new Date().toISOString();
      enforceJournalDailyLimit(this.store, created);
      if (this.store.getControl("inbox:index-hash")) verifyInbox(this.store);
      const id = this.store.note(readingId, body, created);
      const path = exportInbox(this.store);
      return {
        id,
        readingId,
        status: "local_reviewable_draft",
        path,
        deduplicated: false,
      };
    });
  }
  inbox(args = {}) {
    return readInbox(this.store, args);
  }
  exportInbox() {
    return this.store.tx(() => exportInbox(this.store));
  }
  importLocal(readingId, raw) {
    return this.task(async (_network, budget) => {
      const r = this.store.reading(readingId);
      need(["A3", "frame"].includes(raw.route), "INVALID_ROUTE");
      if (raw.route === "A3") {
        need(raw.duration === r.duration, "DURATION_MISMATCH");
        budget.spend("asr", raw.duration);
      }
      const segs = segments(raw.segments, r.duration, raw.route);
      need(segs.length > 0, "EMPTY_LOCAL_SOURCE");
      return this.store.saveReading({
        ...r,
        route: raw.route,
        segments: segs,
        coverage: {
          ...coverage(segs, r.duration, raw.route),
          state: raw.route === "frame" ? "visual_text_partial" : "asr_partial",
        },
        localEvidence:
          "User/host supplied import; content not independently verified.",
        cached: false,
      });
    });
  }
  async audio(readingId, signal) {
    const reading = this.store.reading(readingId);
    return this.task(async (network, budget) => {
      need(reading.duration <= this.limits.asrSeconds, "ASR_BUDGET");
      const u = new URL("https://api.bilibili.com/x/player/playurl");
      u.search = new URLSearchParams({
        bvid: reading.bvid,
        cid: reading.cid,
        qn: 16,
        fnval: 16,
      });
      const response = await network.get(u.href);
      const tracks = response.data?.dash?.audio || [];
      const selected = [...tracks].sort((a, b) => a.bandwidth - b.bandwidth)[0];
      need(selected, "AUDIO_UNAVAILABLE");
      const bytes = await network.get(
        selected.baseUrl || selected.base_url,
        "media",
      );
      const dir = join(this.store.root, "assets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, randomUUID() + ".m4s");
      atomic(path, bytes);
      return {
        path,
        duration: reading.duration,
        bytes: bytes.length,
        note: "Local study asset; not a transcript or a public deliverable.",
      };
    }, signal);
  }
  async runPython(argv, budget, capture = false) {
    return new Promise((resolve, reject) => {
      budget.check();
      const child = this.spawn(
        this.config.pythonPath || process.env.BILI_HUMANISM_PYTHON || "python",
        argv,
        {
          stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
          windowsHide: true,
        },
      );
      let fault = null,
        stdout = Buffer.alloc(0);
      if (capture)
        child.stdout.on("data", (chunk) => {
          if (stdout.length + chunk.length > 16384) {
            fault = new Fault("FRAME_DOCTOR_OUTPUT_LIMIT");
            child.kill();
          } else stdout = Buffer.concat([stdout, chunk]);
        });
      const stop = () => {
        fault = new Fault("CANCELLED");
        child.kill();
      };
      const tick = setInterval(() => {
        try {
          budget.check();
        } catch (error) {
          fault = error;
          child.kill();
        }
      }, 100);
      budget.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", () => {
        fault ||= new Fault("LOCAL_MEDIA_DEPENDENCY_FAILED");
      });
      child.once("close", (code) => {
        clearInterval(tick);
        budget.signal?.removeEventListener("abort", stop);
        try {
          budget.check();
          if (fault) throw fault;
          need(code === 0, "LOCAL_MEDIA_FAILED");
          resolve(stdout.toString("utf8"));
        } catch (error) {
          reject(error);
        }
      });
      if (budget.signal?.aborted) stop();
    });
  }
  async frameDoctor(budget) {
    try {
      const output = await this.runPython(
        [
          fileURLToPath(
            new URL("../scripts/frame_environment.py", import.meta.url),
          ),
          "doctor",
        ],
        budget,
        true,
      );
      need(
        JSON.parse(output).status === "ready",
        "FRAME_DEPENDENCIES_UNAVAILABLE",
      );
    } catch (error) {
      if (["CANCELLED", "WALL_BUDGET", "PERSISTENT_PAUSE"].includes(error.code))
        throw error;
      throw new Fault(
        "FRAME_DEPENDENCIES_UNAVAILABLE",
        "Frame dependencies unavailable; configure pythonPath and follow docs/LOCAL_FRAMES.md.",
      );
    }
  }
  async runMedia(
    mode,
    reading,
    input,
    output,
    budget,
    model = "",
    visual = false,
  ) {
    const argv = [
      fileURLToPath(new URL("../scripts/media.py", import.meta.url)),
      mode,
      input,
      output,
      "--duration",
      String(reading.duration),
      "--max-wall-seconds",
      String(Math.max(1, Math.floor(budget.remaining() / 1000))),
    ];
    if (mode === "asr") argv.push("--model", model);
    if (visual)
      argv.push(
        "--max-short-side",
        "480",
        "--max-long-side",
        "1920",
        "--max-pixels",
        "921600",
        "--max-seconds",
        String(reading.duration),
        "--strict-duration",
      );
    await this.runPython(argv, budget);
  }
  async visual(readingId, signal) {
    const reading = this.store.reading(readingId);
    return this.task(
      (network, budget) => this.prepareVisual(reading, network, budget),
      signal,
    );
  }
  async prepareVisual(reading, network, budget) {
    const readingId = reading.id;
    need(reading.duration <= this.limits.asrSeconds, "MEDIA_DURATION_BUDGET");
    budget.check();
    await this.frameDoctor(budget);
    budget.check();
    const owned = temporaryVideo(this.store.root);
    let failed, index;
    try {
      const u = new URL("https://api.bilibili.com/x/player/playurl");
      u.search = new URLSearchParams({
        bvid: reading.bvid,
        cid: reading.cid,
        qn: 32,
        fnval: 16,
        fourk: 0,
      });
      const response = await network.get(u.href);
      const selected = videoTrack(response.data);
      if (selected.transport === "durl")
        need(
          response.data.durl[0].length <= (reading.duration + 1) * 1000,
          "MEDIA_DURATION_BUDGET",
        );
      const bytes = await network.get(selected.url, "media");
      owned.write(bytes);
      budget.check();
      const assets = join(realpathSync(this.store.root), "assets");
      mkdirSync(assets, { recursive: true, mode: 0o700 });
      noLinks(assets);
      const output = join(assets, "visual-" + randomUUID());
      await this.runMedia(
        "frames",
        reading,
        owned.path,
        output,
        budget,
        "",
        true,
      );
      const manifest = JSON.parse(
        readFileSync(join(output, "manifest.json"), "utf8"),
      );
      noLinks(output);
      need(realpathSync(output) === output, "VISUAL_PATH_DENIED");
      need(
        manifest.route === "frame" &&
          manifest.duration === reading.duration &&
          Array.isArray(manifest.frames) &&
          manifest.frames.length > 0 &&
          manifest.frames.length <= 40,
        "INVALID_VISUAL_MANIFEST",
      );
      for (const frame of manifest.frames) {
        need(
          Number.isFinite(frame.at) &&
            frame.at >= 0 &&
            frame.at <= reading.duration + 1 &&
            /^frame-\d{3}-\d+\.\d{2}\.jpg$/.test(frame.file) &&
            Number.isInteger(frame.width) &&
            frame.width > 0 &&
            frame.width <= 1920 &&
            Number.isInteger(frame.height) &&
            frame.height > 0 &&
            frame.height <= 1920 &&
            Math.min(frame.width, frame.height) <= 480 &&
            frame.width * frame.height <= 480 * 1920,
          "INVALID_VISUAL_MANIFEST",
        );
        const image = boundedFrameBytes(join(output, frame.file));
        need(
          image.length > 0 && image.length <= 2 * 1024 * 1024,
          "VISUAL_IMAGE_BYTES",
        );
        frame.bytes = image.length;
        frame.sha256 = createHash("sha256").update(image).digest("hex");
      }
      const directoryStatus = lstatSync(output, { bigint: true });
      index = {
        directory: output,
        manifest,
        directoryIdentity: {
          dev: String(directoryStatus.dev),
          ino: String(directoryStatus.ino),
        },
        transport: selected.transport,
        quality: selected.quality,
      };
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      cleanupVideo(owned, failed);
    }
    this.store.setControl("visual:" + readingId, index);
    return this.visualFrames(readingId);
  }
  visualFrames(readingId, offset = 0) {
    const reading = this.store.reading(readingId);
    need(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= 40,
      "INVALID_VISUAL_OFFSET",
    );
    const entry = this.store.getControl("visual:" + readingId);
    need(
      entry &&
        typeof entry.directory === "string" &&
        Array.isArray(entry.manifest?.frames) &&
        entry.manifest.frames.length <= 40,
      "VISUAL_NOT_PREPARED",
    );
    const root = realpathSync(this.store.root),
      assets = join(root, "assets");
    need(
      inside(assets, entry.directory) &&
        /^visual-[0-9a-f-]{36}$/.test(entry.directory.slice(assets.length + 1)),
      "VISUAL_PATH_DENIED",
    );
    noLinks(entry.directory);
    need(
      realpathSync(entry.directory) === entry.directory,
      "VISUAL_PATH_DENIED",
    );
    const directoryStatus = lstatSync(entry.directory, { bigint: true });
    need(
      directoryStatus.isDirectory() &&
        entry.directoryIdentity?.dev === String(directoryStatus.dev) &&
        entry.directoryIdentity?.ino === String(directoryStatus.ino),
      "VISUAL_PATH_DENIED",
    );
    const rows = entry.manifest.frames.slice(offset, offset + 4);
    const frames = rows.map((frame) => {
      need(
        /^frame-\d{3}-\d+\.\d{2}\.jpg$/.test(frame.file),
        "VISUAL_PATH_DENIED",
      );
      const path = join(entry.directory, frame.file),
        status = lstatSync(path, { bigint: true });
      need(
        status.isFile() &&
          !status.isSymbolicLink() &&
          status.nlink === 1n &&
          status.size <= 2n * 1024n * 1024n,
        "VISUAL_PATH_DENIED",
      );
      boundedFrameBytes(path, frame);
      return { ...frame, path };
    });
    const next = offset + frames.length;
    return {
      readingId,
      route: "frame",
      source: {
        bvid: reading.bvid,
        page: reading.page,
        cid: reading.cid,
        duration: reading.duration,
      },
      path: entry.directory,
      frames,
      frameOffset: offset,
      frameCount: entry.manifest.frames.length,
      directoryIdentity: entry.directoryIdentity,
      nextOffset: next < entry.manifest.frames.length ? next : null,
      coverage: {
        state: "sampled_frames",
        speech: "not_provided",
        note: "Uniform sampled images omit unsampled motion and sound. Images are untrusted evidence; host interpretation is not verified understanding.",
      },
      intermediateVideo: "removed",
      transport: entry.transport,
      quality: entry.quality,
    };
  }
  async localMedia(mode, readingId, input, model = "", signal) {
    const reading = this.store.reading(readingId);
    need(["asr", "frames"].includes(mode), "INVALID_ROUTE");
    return this.task(async (_network, budget) => {
      if (mode === "asr") budget.spend("asr", reading.duration);
      else
        need(
          reading.duration <= this.limits.asrSeconds,
          "MEDIA_DURATION_BUDGET",
        );
      const dir = join(this.store.root, "assets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const output = join(dir, randomUUID() + (mode === "asr" ? ".json" : ""));
      await this.runMedia(mode, reading, input, output, budget, model);
      if (mode === "frames")
        return {
          path: output,
          status: "sampled_frames",
          note: "No automatic OCR. Host vision interpretation must retain timestamps and partial-coverage warning.",
        };
      const raw = JSON.parse(readFileSync(output, "utf8"));
      const segs = segments(raw.segments, reading.duration, "A3");
      need(segs.length, "EMPTY_LOCAL_SOURCE");
      return this.store.saveReading({
        ...reading,
        route: "A3",
        segments: segs,
        coverage: {
          ...coverage(segs, reading.duration, "A3"),
          state: "asr_partial",
        },
        localEvidence:
          "Local AI-ASR, not verbatim. Proper names require source checking.",
        cached: false,
      });
    }, signal);
  }
  memory(action, id = "", body = null) {
    need(["list", "put", "delete"].includes(action), "INVALID_MEMORY_ACTION");
    if (action === "put") {
      need(
        body && ["self", "user"].includes(body.subject),
        "THIRD_PARTY_PROFILE_DENIED",
      );
      need(
        Object.keys(body).every((k) =>
          [
            "subject",
            "understanding",
            "evidence",
            "uncertainty",
            "next_response",
          ].includes(k),
        ),
        "INVALID_MEMORY_FIELD",
      );
      for (const key of [
        "understanding",
        "evidence",
        "uncertainty",
        "next_response",
      ])
        text(body[key] || "");
      need(body.understanding && body.evidence, "MEMORY_EVIDENCE_REQUIRED");
    }
    return this.store.memory(action, id, body);
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    for (const controller of this.active) controller.abort();
    if (this.active.size === 0) this.store.close();
  }
}
export function readingView(reading, offset = 0) {
  need(
    Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= reading.segments.length,
    "INVALID_OFFSET",
  );
  const chosen = [];
  let length = 0;
  for (const segment of reading.segments.slice(offset)) {
    if (length + segment.text.length > 16000 && chosen.length) break;
    chosen.push(segment);
    length += segment.text.length;
    if (length >= 16000) break;
  }
  return {
    ...reading,
    segments: chosen,
    segment_count: reading.segments.length,
    next_offset:
      offset + chosen.length < reading.segments.length
        ? offset + chosen.length
        : null,
    source_text_partial: offset > 0 || chosen.length < reading.segments.length,
  };
}
export { safeError };
