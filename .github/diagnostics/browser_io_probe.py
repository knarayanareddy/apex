#!/usr/bin/env python3
"""Diagnostic only: one observed browser with disk, tmpfs, or no writer."""
import argparse
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time


def writer(path, seconds, max_bytes):
    started = time.monotonic()
    count = 0
    block = os.urandom(1024 * 1024)
    ready = False
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_SYNC, 0o600)
    try:
        while time.monotonic() - started < seconds and count < max_bytes:
            if count:
                readable, _, _ = select.select([sys.stdin], [], [], 0)
                if readable and sys.stdin.buffer.read(1):
                    break
            os.lseek(fd, count % (64 * 1024 * 1024), os.SEEK_SET)
            written = os.write(fd, block)
            if written != len(block):
                raise RuntimeError("short pressure write")
            count += written
            if not ready:
                print("PRESSURE_READY", flush=True)
                ready = True
            time.sleep(0.025)
    finally:
        os.close(fd)
    print(json.dumps({"bytes_written": count, "elapsed_ms": round((time.monotonic() - started) * 1000)}), flush=True)
    return 0 if ready else 1


def run(condition, observer, browser_path="/usr/bin/chromium"):
    runner_temp = pathlib.Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    browser = pathlib.Path(browser_path).resolve(strict=True)
    base = pathlib.Path("/dev/shm") if condition == "tmpfs-pressure" else runner_temp
    owned = pathlib.Path(tempfile.mkdtemp(prefix="apex-browser-pressure-", dir=base))
    same_device = browser.stat().st_dev == owned.stat().st_dev
    expected_device = condition == "disk-pressure"
    if condition != "control" and same_device != expected_device:
        print("IO_DIAGNOSTIC " + json.dumps({"condition": condition, "valid": False, "reason": "unexpected_device"}), flush=True)
        print("IO_DIAGNOSTIC_FIXTURE " + str(owned), file=sys.stderr, flush=True)
        return 2
    worker = None
    worker_data = None
    worker_at_launch = None
    worker_at_exit = None
    browser_exit = None
    error = None
    try:
        if condition != "control":
            worker = subprocess.Popen([sys.executable, __file__, "--worker", str(owned / "pressure.bin")],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            deadline = time.monotonic() + 15
            line = bytearray()
            while time.monotonic() < deadline and not line.endswith(b"\n") and len(line) < 64:
                readable, _, _ = select.select([worker.stdout], [], [], max(0, deadline - time.monotonic()))
                if not readable:
                    break
                byte = os.read(worker.stdout.fileno(), 1)
                if not byte:
                    break
                line.extend(byte)
            if line.strip() != b"PRESSURE_READY" or worker.poll() is not None:
                raise RuntimeError("pressure worker did not become ready")
            worker_at_launch = worker.poll() is None
        started = time.monotonic()
        browser_exit = subprocess.call([sys.executable, observer, "--compare", browser_path])
        browser_ms = round((time.monotonic() - started) * 1000)
        if worker:
            worker_at_exit = worker.poll() is None
    except BaseException as exc:
        error = exc
    finally:
        if worker:
            try:
                if worker.poll() is None:
                    worker.stdin.write(b"q")
                    worker.stdin.flush()
                worker.stdin.close()
                worker.stdin = None
                output, stderr = worker.communicate(timeout=30)
                if worker.returncode != 0:
                    raise RuntimeError("pressure worker failed: " + stderr[:200].decode("utf8", "replace"))
                worker_data = json.loads(output.decode("utf8").strip())
            except BaseException as exc:
                if error is None:
                    error = exc
    if error is not None:
        print("IO_DIAGNOSTIC_ERROR " + type(error).__name__ + ": " + str(error), file=sys.stderr, flush=True)
        print("IO_DIAGNOSTIC_FIXTURE " + str(owned), file=sys.stderr, flush=True)
        return 2
    valid = condition == "control" or (worker_at_launch and worker_at_exit)
    print("IO_DIAGNOSTIC " + json.dumps({"condition": condition, "valid": valid, "same_device": same_device,
          "browser_exit": browser_exit, "browser_total_ms": browser_ms, "worker_active_at_launch": worker_at_launch,
          "worker_active_at_exit": worker_at_exit, "worker": worker_data}, separators=(",", ":")), flush=True)
    return browser_exit if valid else 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--condition", choices=["control", "disk-pressure", "tmpfs-pressure"])
    parser.add_argument("--observer")
    parser.add_argument("--worker")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.worker:
        return writer(args.worker, 20, 1024 * 1024 * 1024)
    if args.self_test:
        owned = pathlib.Path(tempfile.mkdtemp(prefix="apex-browser-pressure-selftest-"))
        file = owned / "one-block"
        result = writer(file, 0.2, 1024 * 1024)
        if result == 0:
            file.unlink()
            owned.rmdir()
        else:
            print("IO_DIAGNOSTIC_FIXTURE " + str(owned), file=sys.stderr, flush=True)
        return result
    if not args.condition or not args.observer or sys.platform != "linux":
        raise RuntimeError("Linux, an explicit condition and observer path are required")
    return run(args.condition, args.observer)


if __name__ == "__main__":
    sys.exit(main())
