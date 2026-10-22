import test from "node:test";
import assert from "node:assert/strict";
import {
  probeNames,
  probeSpeechSeconds,
  summarizeProbe,
} from "../lib/quality.mjs";

test("probeNames accepts the documented group syntax", () => {
  assert.deepEqual(probeNames(undefined), []);
  assert.deepEqual(probeNames(" 店铺 = 聚福楼 , 聚福搂 ;; 人物=林师傅 "), [
    "店铺=聚福楼,聚福搂",
    "人物=林师傅",
  ]);
  assert.deepEqual(probeNames(["店铺=聚福楼"]), ["店铺=聚福楼"]);
});

test("probeNames rejects malformed, oversized and injection-shaped input", () => {
  assert.throws(() => probeNames("店铺"), { code: "PROBE_NAMES_INVALID" });
  assert.throws(() => probeNames("=甲,乙"), { code: "PROBE_NAMES_INVALID" });
  assert.throws(() => probeNames("店铺="), { code: "PROBE_NAMES_INVALID" });
  assert.throws(() => probeNames(42), { code: "PROBE_NAMES_INVALID" });
  assert.throws(() => probeNames("a=" + "x".repeat(41)), {
    code: "PROBE_NAMES_INVALID",
  });
  assert.throws(
    () => probeNames(Array.from({ length: 9 }, (_, i) => `n${i}=a`)),
    { code: "PROBE_NAMES_TOO_MANY" },
  );
  assert.throws(() => probeNames("店铺=" + ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join(",")), {
    code: "PROBE_NAMES_INVALID",
  });
  assert.throws(() => probeNames("--output; rm -rf /"), {
    code: "PROBE_NAMES_INVALID",
  });
});

test("probeSpeechSeconds stays inside the source duration", () => {
  assert.equal(probeSpeechSeconds(undefined, 60), 0);
  assert.equal(probeSpeechSeconds(12.345, 60), 12.35);
  assert.equal(probeSpeechSeconds(60.5, 60), 60.5);
  assert.throws(() => probeSpeechSeconds(62, 60), {
    code: "PROBE_SPEECH_INVALID",
  });
  assert.throws(() => probeSpeechSeconds(0, 60), {
    code: "PROBE_SPEECH_INVALID",
  });
  assert.throws(() => probeSpeechSeconds(NaN, 60), {
    code: "PROBE_SPEECH_INVALID",
  });
});

const raw = {
  probe: "text",
  route: "A2",
  probes: {
    profile: {
      segmentCount: 3,
      charCount: 300,
      coverage: { timedSeconds: 20, timedFraction: 0.5 },
      density: {
        charsPerMinute: 900,
        effectiveCharsPerMinute: 600,
        denominator: "speech",
        class: "spoken",
        note: "talking speed only",
      },
    },
    names: [
      {
        object: "店铺",
        forms: [{ form: "聚福楼", count: 2, firstSeenSeconds: 8 }],
        total: 2,
        formCount: 1,
        signal: "single_form",
        verdict: "no_signal",
        note: "cannot see a stable error",
      },
    ],
    latin: {
      tokens: Array.from({ length: 80 }, (_, i) => ({
        token: "t" + i,
        count: 1,
        firstSeenSeconds: 1,
      })),
      fragments: Array.from({ length: 80 }, (_, i) => ({
        token: "f" + i,
        count: 1,
        firstSeenSeconds: 2,
      })),
      note: "candidates, not errors",
    },
    drift: {
      linesWithTraditionalGlyphs: 1,
      segmentCount: 3,
      fraction: 0.33,
      samples: [{ at: 3, text: "這是" }],
      note: "observation only",
    },
  },
  limits: "program-side statistics only",
};

test("summarizeProbe bounds model-facing arrays and drops samples", () => {
  const out = summarizeProbe(raw);
  assert.equal(out.probes.latin.tokens.length, 40);
  assert.equal(out.probes.latin.fragments.length, 40);
  assert.equal(out.probes.latin.tokenTotal, 80);
  assert.equal(out.probes.latin.fragmentTotal, 80);
  assert.equal(out.probes.drift.samples, undefined);
  assert.equal(out.probes.profile.density.effectiveCharsPerMinute, 600);
  assert.equal(out.probes.profile.density.denominator, "speech");
  assert.equal(out.probes.names[0].signal, "single_form");
  assert.equal(out.limits, "program-side statistics only");
});

test("summarizeProbe keeps a missing density honest instead of inventing a rate", () => {
  const out = summarizeProbe({
    probe: "text",
    probes: {
      profile: {
        segmentCount: 0,
        charCount: 0,
        coverage: null,
        density: {
          charsPerMinute: null,
          effectiveCharsPerMinute: null,
          denominator: "unknown",
          class: "unknown",
          note: "no duration",
        },
      },
    },
  });
  assert.equal(out.probes.profile.density.charsPerMinute, null);
  assert.equal(out.probes.profile.density.class, "unknown");
  assert.equal(out.probes.names, undefined);
});
