import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, atomic } from "./store.mjs";
import { Budget } from "./budget.mjs";
import { Network } from "./network.mjs";
import { readVideo, candidates, coverage, segments } from "./reader.mjs";
import { need, safeError } from "./errors.mjs";
import { Writer, grant, writeStatus, confirmConsumption } from "./writer.mjs";
import { personality } from "./personality.mjs";
const fields = [
  "encounter",
  "facts",
  "author_view",
  "inference",
  "previous_judgment",
  "revision",
  "missing",
  "next_response",
];
const labels = {
  encounter: "遇见谁与怎样的处境",
  facts: "材料明示",
  author_view: "作者观点",
  inference: "AI 推测",
  previous_judgment: "先前的判断",
  revision: "认识的修正",
  missing: "材料限度与遗漏",
  next_response: "下一次如何回应",
};
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
const mdEscape = (s) =>
  String(s).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export class Service {
  constructor(config = {}, dependencies = {}) {
    this.config = { ...config };
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
    return this.task(async (network) => {
      const reading = await readVideo(input, page, network, this.store);
      return this.store.saveReading(reading);
    }, signal);
  }
  async candidates(count = 3, signal) {
    return this.task((network) => candidates(network, count), signal);
  }
  status() {
    const writes = writeStatus(this.config);
    return {
      ...this.store.status(),
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
    const id = this.store.note(readingId, body);
    this.exportInbox();
    return {
      id,
      readingId,
      status: "local_reviewable_draft",
      path: join(this.store.root, "inbox.md"),
    };
  }
  exportInbox() {
    const lines = [
      "# 遇见人 · 本地收件箱",
      "",
      "这里的手账是 AI 的可审阅草稿。出处可追问，记忆可修正；手账保存在本地，不由收件箱发布。",
      "",
    ];
    for (const n of this.store.inbox()) {
      const r = this.store.reading(n.reading_id);
      lines.push(
        `## ${mdEscape(r.title)} · ${mdEscape(r.author)}`,
        r.url,
        `\n记录 ${n.id} · ${n.created} · 来源 ${r.route} · 覆盖 ${r.coverage.state}`,
      );
      for (const k of fields)
        if (n.body[k]) lines.push(`\n**${labels[k]}**\n${mdEscape(n.body[k])}`);
      for (const e of n.body.evidence)
        lines.push(`\n- [${e.at}s](${e.url}) ${mdEscape(e.claim)}`);
    }
    const esc = (s) =>
      String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    const articles = this.store
      .inbox()
      .map((n) => {
        const r = this.store.reading(n.reading_id);
        return `<article><p class="eyebrow">${esc(r.route)} · ${esc(r.coverage.state)} · 本地草稿</p><h2>${esc(r.title)}</h2><p class="byline">${esc(r.author)} · <a href="${esc(r.url)}" rel="noreferrer">回到作品</a></p>${fields
          .filter((k) => n.body[k])
          .map(
            (k) =>
              `<section><h3>${labels[k]}</h3><p>${esc(n.body[k]).replaceAll("\n", "<br>")}</p></section>`,
          )
          .join(
            "",
          )}<ul>${n.body.evidence.map((e) => `<li><a href="${esc(e.url)}" rel="noreferrer">${e.at}s</a> ${esc(e.claim)}</li>`).join("")}</ul><footer>记录 ${esc(n.id)} · ${esc(n.created)}</footer></article>`;
      })
      .join("");
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>遇见人 · 本地收件箱</title><style>body{margin:0;background:#f3f0e8;color:#283a36;font:17px/1.85 system-ui,'Microsoft YaHei',sans-serif}main{max-width:900px;margin:auto;padding:52px 24px}h1{font-size:44px;letter-spacing:4px;margin:8px 0}.eyebrow{color:#857044;letter-spacing:2px;font-size:13px}header{border-bottom:1px solid #c8c6b6;padding-bottom:30px;margin-bottom:35px}header p{max-width:680px}article{background:#fffdf7;padding:35px 42px;margin:28px 0;border:1px solid #dedacb;border-radius:6px}h2{font-size:28px;margin:8px 0}h3{font-size:16px;margin:26px 0 6px;color:#6f714e}p{margin:6px 0}.byline,footer{font-size:13px;color:#757b72}a{color:#28675c}footer{border-top:1px solid #e7e3d7;margin-top:26px;padding-top:14px}.tag{display:inline-block;border:1px solid #9da998;padding:2px 12px;border-radius:20px;font-size:13px;margin:8px 8px 0 0}@media(max-width:600px){article{padding:22px}h1{font-size:34px}}</style><main><header><p class="eyebrow">DSH · BILI HUMANISM</p><h1>遇见人</h1><p>从人的创作与生活中学习理解人，认真对待人。保留作品的声音，也留下认识改变的依据。</p><span class="tag">本地收件箱</span><span class="tag">出处可追问</span><span class="tag">记忆可修正</span></header>${articles || "<p>收件箱暂时为空。允许没有新发现，也允许只看一部喜欢的作品。</p>"}</main></html>`;
    atomic(join(this.store.root, "inbox.html"), html);
    atomic(join(this.store.root, "inbox.md"), lines.join("\n"));
    return join(this.store.root, "inbox.md");
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
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.BILI_HUMANISM_PYTHON || "python",
          argv,
          { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
        );
        let fault = null;
        const stop = () => {
          fault = new Error("cancel");
          child.kill();
        };
        const tick = setInterval(() => {
          try {
            budget.check();
          } catch (e) {
            fault = e;
            child.kill();
          }
        }, 100);
        budget.signal?.addEventListener("abort", stop, { once: true });
        child.once("error", () => {
          clearInterval(tick);
          budget.signal?.removeEventListener("abort", stop);
          reject(new Error("Local media dependency failed"));
        });
        child.once("exit", (code) => {
          clearInterval(tick);
          budget.signal?.removeEventListener("abort", stop);
          try {
            budget.check();
            if (fault) throw fault;
            need(code === 0, "LOCAL_MEDIA_FAILED");
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
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
