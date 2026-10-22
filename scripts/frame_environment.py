"""Inspect or smoke-test optional local frame extraction, without platform requests.

python scripts/frame_environment.py doctor
python scripts/frame_environment.py smoke

This does not install packages, download media/models, run OCR, or invoke host vision.
"""

import argparse
import importlib
import importlib.metadata
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
from fractions import Fraction


def doctor():
    """Import the actual decoding and image modules in this interpreter."""
    pinned = dict(
        line.strip().split("==", 1)
        for line in Path(__file__).with_name("requirements-frames.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    dependencies = []
    for distribution, module in (("av", "av"), ("Pillow", "PIL.Image")):
        row = {"package": distribution, "expected_version": pinned[distribution]}
        try:
            importlib.import_module(module)
            version = importlib.metadata.version(distribution)
            row.update(status="available" if version == pinned[distribution] else "version_mismatch", version=version)
        except Exception as exc:
            # Native loader errors can contain paths; report only the failure type.
            row.update(status="unavailable", error=type(exc).__name__)
        dependencies.append(row)
    python_supported = sys.version_info >= (3, 10)
    ready = python_supported and all(row["status"] == "available" for row in dependencies)
    return {
        "operation": "doctor",
        "status": "ready" if ready else "dependencies_unavailable",
        "python": {"version": sys.version.split()[0], "supported": python_supported},
        "dependencies": dependencies,
        "local_frame_extraction": "ready_for_smoke" if ready else "unavailable",
        "host_vision": {
            "status": "not_tested",
            "required": True,
            "note": "A host vision model must read the generated images; no local semantic recognizer or OCR is provided.",
        },
        "platform_requests": 0,
    }


def smoke():
    """Encode known-color synthetic media, then exercise the shipped frame adapter."""
    report = doctor()
    report["operation"] = "smoke"
    if report["status"] != "ready":
        return report
    stage = "generate_synthetic_video"
    try:
        import av
        from PIL import Image

        colors = [(240, 20, 20), (20, 240, 20), (20, 20, 240), (240, 240, 20)]
        with tempfile.TemporaryDirectory(prefix="humanism-frames-smoke-") as temp:
            root = Path(temp)
            video = root / "synthetic.mkv"
            with av.open(str(video), mode="w") as container:
                stream = container.add_stream("ffv1", rate=4)
                stream.width, stream.height, stream.pix_fmt = 160, 96, "bgr0"
                for index in range(16):
                    image = Image.new("RGB", (160, 96), colors[index // 4])
                    frame = av.VideoFrame.from_image(image)
                    frame.pts, frame.time_base = index, Fraction(1, 4)
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
            stage = "run_frame_adapter"
            output = root / "frames"
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("media.py")),
                 "frames", str(video), str(output), "--duration", "4",
                 "--interval", "1", "--max-seconds", "4", "--max-wall-seconds", "15"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=20, check=False,
            )
            if result.returncode:
                report.update(status="failed", stage=stage, error="ADAPTER_FAILED", adapter_exit_code=result.returncode)
                return report
            stage = "verify_images_and_timestamps"
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            rows = manifest["frames"]
            if manifest["route"] != "frame" or manifest["duration"] != 4 or len(rows) != 4:
                raise ValueError("Unexpected synthetic manifest")
            timestamps = []
            maximum_error = 0
            for index, row in enumerate(rows):
                timestamp = float(row["at"])
                if not math.isfinite(timestamp) or abs(timestamp - index) > 0.01:
                    raise ValueError("Unexpected synthetic timestamp")
                filename = row["file"]
                if Path(filename).name != filename or not filename.endswith(".jpg"):
                    raise ValueError("Unexpected synthetic filename")
                with Image.open(output / filename) as image:
                    if image.size != (160, 96):
                        raise ValueError("Unexpected synthetic dimensions")
                    pixel = image.convert("RGB").getpixel((80, 48))
                    error = max(abs(actual - expected) for actual, expected in zip(pixel, colors[index]))
                    maximum_error = max(maximum_error, error)
                    if error > 15:
                        raise ValueError("Synthetic color check failed")
                timestamps.append(timestamp)
            report.update(
                status="passed", local_frame_extraction="synthetic_smoke_passed",
                synthetic={"seconds": 4, "frames": len(rows), "timestamps": timestamps,
                           "dimensions": [160, 96], "max_color_channel_error": maximum_error,
                           "fixture": "generated_locally; no external source material",
                           "temporary_media_removed": True},
                note="Decode, sampling and JPEG output passed for this synthetic fixture. Host vision and real-source understanding remain untested.",
            )
    except Exception as exc:
        report.update(status="failed", stage=stage, error=type(exc).__name__)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("doctor", "smoke"))
    args = parser.parse_args()
    report = doctor() if args.operation == "doctor" else smoke()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] in ("ready", "passed") else 2


if __name__ == "__main__":
    raise SystemExit(main())
