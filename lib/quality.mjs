import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runEnvironment } from "./media-environment.mjs";
import { need } from "./errors.mjs";

export const textProbeScript = fileURLToPath(
  new URL("../scripts/text_probe.py", import.meta.url),
);
export const audioProbeScript = fileURLToPath(
  new URL("../scripts/audio_probe.py", import.meta.url),
);

// Offline quality probes over an already stored reading. No network, no credentials, no model.
// The program only computes statistics; whether a name is right or whether any of it was understood
// stays a human judgement.

const MAX_NAMES_GROUPS = 8;
const MAX_FORMS_PER_GROUP = 8;
const MAX_FORM_LENGTH = 40;
// Mirrors the Python adapters. Kept separate so a malformed request fails before a process starts.
const PROBE_TIMEOUT_MS = 120000;
const PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;

export function probeNames(value) {
  const list =
    value === undefined
      ? []
      : typeof value === "string"
        ? value
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean)
        : value;
  need(Array.isArray(list), "PROBE_NAMES_INVALID");
  need(list.length <= MAX_NAMES_GROUPS, "PROBE_NAMES_TOO_MANY");
  return list.map((entry) => {
    need(typeof entry === "string" && entry.length <= 600, "PROBE_NAMES_INVALID");
    const [object, forms = ""] = entry.split("=");
    const parts = forms
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    need(
      object.trim().length > 0 &&
        object.trim().length <= MAX_FORM_LENGTH &&
        parts.length > 0 &&
        parts.length <= MAX_FORMS_PER_GROUP &&
        parts.every((f) => f.length <= MAX_FORM_LENGTH),
      "PROBE_NAMES_INVALID",
    );
    return object.trim() + "=" + parts.join(",");
  });
}

export function probeSpeechSeconds(value, duration) {
  if (value === undefined || value === null) return 0;
  need(
    Number.isFinite(value) && value > 0 && value <= duration + 1,
    "PROBE_SPEECH_INVALID",
  );
  return Math.round(value * 100) / 100;
}

/**
 * Trim the probe payload for a model-facing answer: the full bucket/token arrays stay on disk in the
 * CLI path, and the tool returns a bounded summary so a long transcript cannot flood the context.
 */
export function summarizeProbe(result, limits = { tokens: 40, fragments: 40, buckets: 40 }) {
  const out = { probe: result.probe, route: result.route ?? null, probes: {} };
  const p = result.probes || {};
  if (p.profile) {
    const d = p.profile.density || {};
    out.probes.profile = {
      segmentCount: p.profile.segmentCount,
      charCount: p.profile.charCount,
      coverage: p.profile.coverage,
      density: {
        charsPerMinute: d.charsPerMinute ?? null,
        effectiveCharsPerMinute: d.effectiveCharsPerMinute ?? null,
        denominator: d.denominator,
        class: d.class,
        note: d.note,
      },
    };
  }
  if (p.names) {
    out.probes.names = p.names.map((g) => ({
      object: g.object,
      forms: g.forms,
      total: g.total,
      formCount: g.formCount,
      signal: g.signal,
      verdict: g.verdict,
      note: g.note,
    }));
  }
  if (p.latin) {
    out.probes.latin = {
      tokens: (p.latin.tokens || []).slice(0, limits.tokens),
      fragments: (p.latin.fragments || []).slice(0, limits.fragments),
      tokenTotal: (p.latin.tokens || []).length,
      fragmentTotal: (p.latin.fragments || []).length,
      note: p.latin.note,
    };
  }
  if (p.drift) {
    out.probes.drift = {
      linesWithTraditionalGlyphs: p.drift.linesWithTraditionalGlyphs,
      segmentCount: p.drift.segmentCount,
      fraction: p.drift.fraction,
      note: p.drift.note,
    };
  }
  if (result.audio) {
    out.audio = {
      decodedSeconds: result.audio.decodedSeconds,
      speechSeconds: result.audio.speechSeconds,
      silentSeconds: result.audio.silentSeconds,
      thresholdDb: result.audio.thresholdDb,
      bucketSeconds: result.audio.bucketSeconds,
      silentRuns: (result.audio.silentRuns || []).slice(0, 20),
      runTotal: (result.audio.silentRuns || []).length,
      note: result.audio.note,
    };
  }
  out.limits = result.limits;
  return out;
}

export async function runTextProbe({
  python,
  workDir,
  reading,
  names = [],
  speechSeconds = 0,
  duration = 0,
  runner = runEnvironment,
}) {
  const input = join(workDir, `probe-${randomUUID()}.json`);
  const output = input.replace(/\.json$/, "-out.json");
  try {
    mkdirSync(workDir, { recursive: true });
    const body = {
      route: reading.route,
      duration: duration || reading.duration,
      segments: reading.segments,
    };
    writeFileSync(input, JSON.stringify(body), { mode: 0o600 });
    const args = [
      textProbeScript,
      "all",
      input,
      "--output",
      output,
      "--max-char",
      "120000",
    ];
    if (duration || reading.duration)
      args.push("--duration", String(duration || reading.duration));
    if (speechSeconds) args.push("--speech-seconds", String(speechSeconds));
    if (names.length) args.push("--names", names.join(";"));
    const run = await runner(python, args, { timeout: PROBE_TIMEOUT_MS });
    need(run.code === 0, "PROBE_FAILED");
    const raw = readFileSync(output, "utf8");
    need(Buffer.byteLength(raw) <= PROBE_OUTPUT_BYTES, "PROBE_OUTPUT_LIMIT");
    return JSON.parse(raw);
  } finally {
    for (const file of [input, output]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // A leftover probe scratch file is not worth failing the read over; it lives under the
        // private data directory and contains no credentials.
      }
    }
  }
}

/**
 * Local CLI only. The media path is supplied by the human operator, never by a model tool, and the
 * file is decoded in place: nothing is copied out of the operator's directory.
 */
export async function runAudioProbe({
  python,
  file,
  workDir,
  bucket = 15,
  threshold = -25,
  minRun = 60,
  stride = 4,
  maxSeconds = 3600,
  runner = runEnvironment,
}) {
  const output = join(workDir, `audio-probe-${randomUUID()}.json`);
  try {
    mkdirSync(workDir, { recursive: true });
    const run = await runner(
      python,
      [
        audioProbeScript,
        "profile",
        file,
        "--bucket",
        String(bucket),
        "--threshold",
        String(threshold),
        "--min-run",
        String(minRun),
        "--stride",
        String(stride),
        "--max-seconds",
        String(maxSeconds),
        "--output",
        output,
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    need(run.code === 0, "AUDIO_PROBE_FAILED");
    const raw = readFileSync(output, "utf8");
    need(Buffer.byteLength(raw) <= PROBE_OUTPUT_BYTES, "PROBE_OUTPUT_LIMIT");
    return JSON.parse(raw);
  } finally {
    try {
      rmSync(output, { force: true });
    } catch {
      // See above: scratch cleanup failure must not mask the probe result.
    }
  }
}
