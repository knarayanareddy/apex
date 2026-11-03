#!/usr/bin/env python3
"""Stage and intentionally pre-read a browser executable; diagnostic only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def stage(source, destination):
    source = source.resolve(strict=True)
    destination.mkdir(mode=0o700)
    started = time.monotonic()
    target = destination / "chrome"
    shutil.copyfile(source, target)
    target.chmod(source.stat().st_mode & 0o777)
    for item in source.parent.iterdir():
        if item.name != source.name:
            (destination / item.name).symlink_to(item)
    original_hash = digest(source)
    target_hash = digest(target)  # Intentionally pre-read: not qualification.
    if original_hash != target_hash:
        raise RuntimeError("staged executable differs from source")
    return {"bytes": target.stat().st_size, "sha256": target_hash,
            "same_device": source.stat().st_dev == target.stat().st_dev,
            "stage_ms": round((time.monotonic() - started) * 1000)}


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("This diagnostic accepts no arguments")
    result = stage(Path("/usr/bin/chromium"), Path(os.environ["RUNNER_TEMP"]) / "apex-stage")
    print("STAGED_EXECUTABLE_DIAGNOSTIC " + json.dumps(result), flush=True)
