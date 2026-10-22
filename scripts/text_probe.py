"""Offline text quality probes for an already fetched source. No network, no credentials, no model.

python text_probe.py all segments.json --duration 157 [--speech-seconds 120] [--names "对象=形态1,形态2;对象2=形态3"]
python text_probe.py names segments.json --names "某机构=形态甲,形态乙"
python text_probe.py profile segments.json --duration 157 --speech-seconds 120
python text_probe.py latin segments.json
python text_probe.py drift segments.json

What this script does NOT do: decide whether a proper name is correct. It only reports the form
distribution inside one transcript, which is a signal a human still has to read. A transcript that
stably uses one wrong form and a transcript that is right look identical here.
"""
import argparse, json, re, sys, unicodedata
from pathlib import Path

# Simplified/Traditional pairs that actually differ in glyph. Same-shape characters
# (繁/然/候/实/会/虽/荣) must never be listed, or ordinary simplified text reports false drift.
TRAD_CHARS = set("體樣幾後們個時現實問題會這來點爲說當裡讓雖寫轉設備區國學與師長門馬鳥魚龍")
# Time-stamped transcript lines such as [00:01:23] are not body text.
TS_LINE = re.compile(r"^\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s?(.*)$")
# SRT cue timing and index lines must never be counted as body text.
SRT_LINE = re.compile(r"^\s*(?:\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->|[-–]?\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*$|\d+\s*$)")
# A complete-looking Latin token; 3+ letters is the level that reliably means "a word appeared".
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9\-\.']{2,}")
# Isolated 1-2 character Latin fragments are reported separately: they are what a model emits
# when it is unsure of a sound, and folding them into the token probe hides them.
LATIN_FRAGMENT = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{1,2}(?![A-Za-z0-9])")
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
LATIN_ALLOW = {
    "ok", "okay", "yes", "no", "hi", "hello", "hey", "wow", "oh", "ah", "eh", "hmm", "mm",
    "bv", "app", "pc", "tv", "ai", "vlog", "pov", "up", "dj", "mv", "bgm", "diy", "led", "usb",
    "gps", "abs", "esp", "wifi", "cpu", "gpu", "url", "http", "https", "www", "com", "cn",
}


def norm(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def load(path):
    """Accept a plugin reading body, {"segments": [...]}, a bare segment array, or plain text."""
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    data = None
    if raw.lstrip()[:1] in "[{":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
    meta = {}
    rows = []
    if isinstance(data, dict):
        meta = {
            "duration": data.get("duration") or data.get("duration_seconds"),
            "route": data.get("route"),
            "title": data.get("title"),
        }
        rows = data.get("segments") or data.get("data") or []
    elif isinstance(data, list):
        rows = data
    segs = []
    for row in rows:
        if isinstance(row, dict):
            body = norm(row.get("text") or row.get("content"))
            if not body:
                continue
            start = row.get("start", row.get("from", row.get("start_timestamp", 0)))
            end = row.get("end", row.get("to", row.get("end_timestamp")))
            segs.append({"start": float(start or 0), "end": None if end is None else float(end), "text": body})
    if not segs:
        for line in raw.splitlines():
            if SRT_LINE.match(line):
                continue
            m = TS_LINE.match(line)
            body = norm(m.group(2) if m else line)
            if not body or body.startswith("#") or body.startswith("|"):
                continue
            segs.append({"start": 0.0, "end": None, "text": body})
    segs.sort(key=lambda s: s["start"])
    return meta, segs


def timed_coverage(segs, duration):
    """Union of timed spans, same definition as the plugin's own coverage field."""
    if not duration:
        return None
    end = covered = 0.0
    for s in segs:
        if s["end"] is None:
            continue
        lo, hi = min(duration, s["start"]), min(duration, s["end"])
        covered += max(0.0, hi - max(end, lo))
        end = max(end, hi)
    return {
        "timedSeconds": round(covered, 2),
        "timedFraction": round(covered / duration, 4) if duration else 0,
    }


def density(chars, duration, speech):
    """Characters per minute over the best available denominator.

    Reporting only chars/duration misreports material whose last minutes carry no narration, and
    reporting only chars/speech misreports material where speech fills the whole file. Both are
    emitted so the two can never be confused for each other.
    """
    out = {
        "charCount": chars,
        "durationSeconds": duration,
        "speechSeconds": speech,
        "charsPerMinute": None,
        "effectiveCharsPerMinute": None,
        "denominator": "unknown",
        "class": "unknown",
        "note": "This measures talking speed, not information density. Performance, music, silent "
        "sequences and text-on-screen material are expected to score low and are not low-value.",
    }
    if duration and duration > 0:
        out["charsPerMinute"] = round(chars / (duration / 60.0), 1)
        out["denominator"] = "duration"
        per = out["charsPerMinute"]
        if speech and 0 < speech < duration:
            out["effectiveCharsPerMinute"] = round(chars / (speech / 60.0), 1)
            out["denominator"] = "speech"
            per = out["effectiveCharsPerMinute"]
        out["class"] = "spoken" if per >= 300 else "mixed" if per >= 150 else "sparse"
    return out


def parse_names(spec):
    groups = []
    for block in (spec or "").split(";"):
        block = block.strip()
        if not block:
            continue
        obj, _, forms = block.partition("=")
        forms = [norm(f) for f in forms.split(",") if norm(f)]
        if obj.strip() and forms:
            groups.append({"object": norm(obj), "forms": forms})
    return groups


def name_forms(segs, groups, limit=20000):
    body = "".join(s["text"] for s in segs)
    out = []
    for g in groups:
        counts = []
        for form in g["forms"]:
            n = body.count(form)
            if n:
                first = next((s["start"] for s in segs if form in s["text"]), None)
                counts.append({"form": form, "count": n, "firstSeenSeconds": first})
        counts.sort(key=lambda c: (-c["count"], c["form"]))
        total = sum(c["count"] for c in counts)
        multi = len(counts) >= 2
        out.append(
            {
                "object": g["object"],
                "forms": counts[:limit],
                "total": total,
                "formCount": len(counts),
                "signal": "multi_form" if multi else "single_form" if total else "absent",
                "verdict": "human_review_required" if multi else "no_signal",
                "note": "Multiple forms in one transcript are a reading signal, not proof of error: "
                "titles, honorifics, pejoratives, abbreviations and old names are legitimate variants. "
                "A single stable form may still be wrong; this probe cannot see that.",
            }
        )
    return out


def latin(segs):
    tokens, fragments = {}, {}
    for s in segs:
        for m in LATIN_TOKEN.finditer(s["text"]):
            w = m.group(0).strip(".'-")
            if len(w) < 3 or w.lower() in LATIN_ALLOW:
                continue
            slot = tokens.setdefault(w, {"token": w, "count": 0, "firstSeenSeconds": s["start"]})
            slot["count"] += 1
        for m in LATIN_FRAGMENT.finditer(s["text"]):
            w = m.group(0)
            if w.lower() in LATIN_ALLOW:
                continue
            # Only fragments glued to CJK are interesting: that is where a model drops a sound it
            # could not place. Short words inside a real Latin sentence ("it", "a") are noise.
            left = s["text"][m.start() - 1] if m.start() > 0 else ""
            right = s["text"][m.end()] if m.end() < len(s["text"]) else ""
            if not (CJK.match(left) or CJK.match(right)):
                continue
            slot = fragments.setdefault(w, {"token": w, "count": 0, "firstSeenSeconds": s["start"]})
            slot["count"] += 1
    order = lambda d: sorted(d.values(), key=lambda x: (-x["count"], x["token"]))
    return {
        "tokens": order(tokens)[:200],
        "fragments": order(fragments)[:200],
        "note": "Latin strings are candidates for source checking, not errors: brand names are "
        "routinely transliterated. Isolated 1-2 character fragments are listed separately because "
        "they are the shape a transcript takes when it is unsure of a sound.",
    }


def drift(segs):
    lines = [s for s in segs if any(ch in TRAD_CHARS for ch in s["text"])]
    return {
        "linesWithTraditionalGlyphs": len(lines),
        "segmentCount": len(segs),
        "fraction": round(len(lines) / len(segs), 4) if segs else 0,
        "samples": [{"at": s["start"], "text": s["text"][:80]} for s in lines[:20]],
        "note": "Mixed glyphs are an observation only. They do not establish a route, a source "
        "language or a transcription quality level.",
    }


def profile(segs, duration, speech):
    chars = sum(len(s["text"]) for s in segs)
    return {
        "segmentCount": len(segs),
        "charCount": chars,
        "timedFirstSeconds": segs[0]["start"] if segs else None,
        "timedLastSeconds": max((s["end"] or s["start"]) for s in segs) if segs else None,
        "coverage": timed_coverage(segs, duration),
        "density": density(chars, duration, speech),
    }


def main():
    ap = argparse.ArgumentParser(description="Offline text probes; never calls the network.")
    ap.add_argument("mode", choices=["all", "names", "profile", "latin", "drift"])
    ap.add_argument("input", type=Path)
    ap.add_argument("--duration", type=float, default=0)
    ap.add_argument("--speech-seconds", type=float, default=0)
    ap.add_argument("--names", default="")
    ap.add_argument("--output", type=Path)
    ap.add_argument("--max-char", type=int, default=200000, help="Refuse oversized input")
    a = ap.parse_args()

    if not a.input.is_file():
        ap.error("Existing local segments file required")
    raw_len = a.input.stat().st_size
    if raw_len > 8 * 1024 * 1024:
        ap.error("Input exceeds 8 MiB")
    meta, segs = load(a.input)
    chars = sum(len(s["text"]) for s in segs)
    if chars > a.max_char:
        ap.error("Body text exceeds --max-char")

    duration = a.duration or float(meta.get("duration") or 0) or 0
    speech = a.speech_seconds or 0.0
    if speech and duration and speech > duration + 1:
        ap.error("--speech-seconds cannot exceed duration")

    result = {
        "probe": "text",
        "route": meta.get("route"),
        "inputBytes": raw_len,
        "probes": {},
    }
    if a.mode in ("all", "profile"):
        result["probes"]["profile"] = profile(segs, duration, speech)
    if a.mode in ("all", "names"):
        result["probes"]["names"] = name_forms(segs, parse_names(a.names))
    if a.mode in ("all", "latin"):
        result["probes"]["latin"] = latin(segs)
    if a.mode in ("all", "drift"):
        result["probes"]["drift"] = drift(segs)
    result["limits"] = (
        "Program-side statistics only. Factual accuracy, semantic quality, whether a name is right "
        "and whether anything was understood are not measured here."
    )

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if a.output:
        a.output.parent.mkdir(parents=True, exist_ok=True)
        a.output.write_text(text, encoding="utf8")
        print(json.dumps({"mode": a.mode, "output": str(a.output), "segments": len(segs)}, ensure_ascii=False))
    else:
        sys.stdout.write(text + "\n")


if __name__ == "__main__":
    main()
