"""Explicit local ASR dependency/model setup. No platform or credential access."""
import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import urllib.request


SPEC = json.loads(Path(__file__).with_name("asr-model.json").read_text(encoding="utf8"))


def verified(path, spec):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != spec["bytes"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == spec["sha256"]


def doctor(model, load=False):
    rows = []
    for distribution, module, expected in (
        ("faster-whisper", "faster_whisper", "1.2.1"),
        ("ctranslate2", "ctranslate2", None),
        ("onnxruntime", "onnxruntime", None),
        ("tokenizers", "tokenizers", None),
    ):
        try:
            importlib.import_module(module)
            version = importlib.metadata.version(distribution)
            rows.append({"package": distribution, "version": version,
                         "status": "available" if expected is None or version == expected else "version_mismatch"})
        except Exception as exc:
            rows.append({"package": distribution, "status": "unavailable", "error": type(exc).__name__})
    ready = all(row["status"] == "available" for row in rows)
    files = bool(model and model.is_dir() and all((model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")))
    result = {"status": "ready" if ready and files else "dependencies_unavailable" if not ready else "model_missing",
              "dependencies": rows, "model": "present_not_loaded" if files else "missing",
              "platform_requests": 0, "downloads": False}
    if load and ready and files:
        from faster_whisper import WhisperModel
        WhisperModel(str(model), device="cpu", compute_type="int8", local_files_only=True)
        result["model"] = "loaded_cpu_int8"
    return result


def download(model):
    # This operation is reachable only from the trusted, explicit setup CLI.
    if model.is_symlink():
        raise ValueError("Linked model directory refused")
    model.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    for spec in SPEC["files"]:
        path = model / spec["name"]
        if verified(path, spec):
            continue
        if path.is_symlink():
            raise ValueError("Linked model file refused")
        temp = model / (spec["name"] + ".partial")
        # Exclusive creation prevents overwriting an unrelated local file.
        created = False
        try:
            with temp.open("xb") as target:
                created = True
                url = "https://huggingface.co/" + SPEC["repository"] + "/resolve/" + SPEC["revision"] + "/" + spec["name"]
                request = urllib.request.Request(url, headers={"User-Agent": "dsh-bili-humanism-media-setup"})
                with urllib.request.urlopen(request, timeout=60) as source:
                    total = 0
                    while True:
                        if time.monotonic() - started > 1800:
                            raise TimeoutError("Model download deadline")
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        total += len(block)
                        if total > spec["bytes"]:
                            raise ValueError("Model download size mismatch")
                        target.write(block)
            if not verified(temp, spec):
                raise ValueError("Model checksum mismatch")
            os.replace(temp, path)
        finally:
            # Only unlink a file created by this call; open(xb) failures leave it alone.
            if created and temp.exists() and not temp.is_symlink():
                temp.unlink()
        print(json.dumps({"stage": "model_file_verified", "file": spec["name"]}), file=sys.stderr, flush=True)
    return {"status": "downloaded_verified", "revision": SPEC["revision"], "bytes": sum(row["bytes"] for row in SPEC["files"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("doctor", "load", "download"))
    parser.add_argument("--model", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "download":
            if args.model is None:
                parser.error("Model destination required")
            result = download(args.model)
        else:
            result = doctor(args.model, load=args.operation == "load")
    except Exception as exc:
        result = {"status": "failed", "error": type(exc).__name__}
    print(json.dumps(result, indent=2))
    return 0 if result["status"] in ("ready", "downloaded_verified") else 2


if __name__ == "__main__":
    raise SystemExit(main())
