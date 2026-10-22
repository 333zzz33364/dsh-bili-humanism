"""Offline audio energy profile for an already downloaded local media file. No network, no model.

python audio_probe.py profile audio.m4s --bucket 15 --threshold -25 --min-run 60
python audio_probe.py profile local.mp4 --output profile.json

Purpose: a transcript's characters-per-minute is normally divided by the whole video duration. When
the last minutes carry no narration at all, that denominator understates talking speed by a wide
margin, and the same material is misread as "little spoken content". This adapter measures the
silent runs so the effective speaking time can be used instead.

Decoded audio only. It does not label speech, music, noise or emotion, and a quiet passage is not
proof that nobody is speaking at low volume.
"""
import argparse, array, json, math, sys, time
from pathlib import Path

SAMPLE_RATE = 16000  # mono 16 kHz is enough for a presence/absence decision and bounds the work.


def frame_bytes(frame):
    """Packed s16 samples from an AudioFrame without numpy.

    PyAV 14+ removed AudioFrame.to_bytes(); the plane is still printable as bytes, and older
    releases expose AudioPlane.to_bytes(). Both paths are accepted so the script is not pinned to a
    single PyAV minor version.
    """
    if not frame.planes:
        return b""
    plane = frame.planes[0]
    to_bytes = getattr(plane, "to_bytes", None)
    data = to_bytes() if callable(to_bytes) else bytes(plane)
    expected = frame.samples * 2  # s16 mono
    return data[:expected] if expected and len(data) > expected else data


def dbfs(square_sum, count):
    if count <= 0:
        return None
    mean = square_sum / count
    if mean <= 0:
        return -96.0
    value = 20.0 * math.log10(math.sqrt(mean) / 32768.0)
    return round(max(value, -96.0), 2)


def decode_samples(path, stride, max_seconds, wall_seconds):
    """Yield (samples, sample_rate) chunks. PyAV is the only third-party dependency here."""
    import av

    started = time.monotonic()
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise RuntimeError("No audio stream")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        emitted = 0
        limit = int(max_seconds * SAMPLE_RATE) if max_seconds else None
        for frame in container.decode(stream):
            if time.monotonic() - started > wall_seconds:
                raise RuntimeError("Audio probe wall budget exceeded")
            for out in resampler.resample(frame) or []:
                data = frame_bytes(out)
                samples = array.array("h")
                samples.frombytes(data[: len(data) - (len(data) % 2)])
                if sys.byteorder == "big":
                    samples.byteswap()
                if stride and stride > 1:
                    samples = samples[::stride]
                if limit is not None and emitted + len(samples) > limit:
                    samples = samples[: max(0, limit - emitted)]
                emitted += len(samples)
                if samples:
                    yield samples, SAMPLE_RATE / float(stride or 1)
            if limit is not None and emitted >= limit:
                break
        for out in resampler.resample(None) or []:
            data = frame_bytes(out)
            samples = array.array("h")
            samples.frombytes(data[: len(data) - (len(data) % 2)])
            if sys.byteorder == "big":
                samples.byteswap()
            if stride and stride > 1:
                samples = samples[::stride]
            if samples:
                yield samples, SAMPLE_RATE / float(stride or 1)


def profile(path, bucket, threshold, min_run, stride, max_seconds, wall_seconds):
    started = time.monotonic()
    per_bucket = max(1, int(bucket * (SAMPLE_RATE / float(stride or 1))))
    buckets = []
    square_sum = 0
    count = 0
    total = 0
    for samples, _rate in decode_samples(path, stride, max_seconds, wall_seconds):
        pos = 0
        while pos < len(samples):
            take = min(len(samples) - pos, per_bucket - count)
            chunk = samples[pos : pos + take]
            # Plain Python: no numpy requirement, and stride keeps the loop short enough to stay
            # inside the shared wall-clock budget.
            square_sum += sum(v * v for v in chunk)
            count += take
            total += take
            pos += take
            if count >= per_bucket:
                buckets.append({"at": round(len(buckets) * bucket, 2), "rmsDb": dbfs(square_sum, count)})
                square_sum = 0
                count = 0
    if count:
        buckets.append(
            {
                "at": round(len(buckets) * bucket, 2),
                "rmsDb": dbfs(square_sum, count),
                "partialSeconds": round(count / (SAMPLE_RATE / float(stride or 1)), 2),
            }
        )
    decoded = round(total / (SAMPLE_RATE / float(stride or 1)), 2)
    if not decoded:
        raise RuntimeError("No audio samples decoded")

    measured = [b["rmsDb"] for b in buckets if b["rmsDb"] is not None]
    measured.sort()
    median = measured[len(measured) // 2] if measured else None
    # Absolute threshold from the human-supplied value, floored by an adaptive one so a uniformly
    # quiet recording is not reported as entirely silent.
    adaptive = round(median - 18.0, 2) if median is not None else None
    effective = max(threshold, adaptive) if adaptive is not None else threshold

    need_buckets = max(1, int(math.ceil(min_run / float(bucket))))
    runs, current = [], None
    for b in buckets:
        quiet = b["rmsDb"] is not None and b["rmsDb"] < effective
        if quiet:
            current = current or {"startSeconds": b["at"], "buckets": 0}
            current["buckets"] += 1
            current["endSeconds"] = round(b["at"] + b.get("partialSeconds", bucket), 2)
        elif current:
            runs.append(current)
            current = None
    if current:
        runs.append(current)
    silent = [
        {
            "startSeconds": r["startSeconds"],
            "endSeconds": min(r["endSeconds"], decoded),
            "seconds": round(min(r["endSeconds"], decoded) - r["startSeconds"], 2),
        }
        for r in runs
        if r["buckets"] >= need_buckets
    ]
    silent_seconds = round(sum(r["seconds"] for r in silent), 2)
    return {
        "probe": "audio",
        "bucketSeconds": bucket,
        "thresholdDb": effective,
        "thresholdConfiguredDb": threshold,
        "medianDb": median,
        "decodedSeconds": decoded,
        "speechSeconds": round(max(0.0, decoded - silent_seconds), 2),
        "silentSeconds": silent_seconds,
        "silentRuns": silent,
        "buckets": buckets,
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "note": "Energy only. A quiet run is not proof of no speech, and speech is not proof of "
        "narration: music and effects occupy the same band. Use this to correct a denominator, "
        "not to claim viewing completeness.",
    }


def main():
    ap = argparse.ArgumentParser(description="Offline audio energy profile; never calls the network.")
    ap.add_argument("mode", choices=["profile"])
    ap.add_argument("input", type=Path)
    ap.add_argument("--bucket", type=float, default=15.0)
    ap.add_argument("--threshold", type=float, default=-25.0)
    ap.add_argument("--min-run", type=float, default=60.0)
    ap.add_argument("--stride", type=int, default=4)
    ap.add_argument("--max-seconds", type=float, default=3600.0)
    ap.add_argument("--max-wall-seconds", type=float, default=110.0)
    ap.add_argument("--output", type=Path)
    a = ap.parse_args()

    if not a.input.is_file():
        ap.error("Existing local audio or video file required")
    if a.bucket < 1 or a.bucket > 120:
        ap.error("--bucket must be within 1-120 seconds")
    if not (-90 <= a.threshold <= -1):
        ap.error("--threshold must be within -90 and -1 dBFS")
    if a.stride < 1 or a.stride > 32:
        ap.error("--stride must be within 1-32")
    if a.min_run < a.bucket:
        ap.error("--min-run must be at least one bucket")

    result = profile(a.input, a.bucket, a.threshold, a.min_run, a.stride, a.max_seconds, a.max_wall_seconds)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if a.output:
        a.output.parent.mkdir(parents=True, exist_ok=True)
        a.output.write_text(text, encoding="utf8")
        print(json.dumps({"mode": a.mode, "output": str(a.output), "speechSeconds": result["speechSeconds"]}, ensure_ascii=False))
    else:
        sys.stdout.write(text + "\n")


if __name__ == "__main__":
    main()
