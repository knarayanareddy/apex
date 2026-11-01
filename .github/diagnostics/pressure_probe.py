#!/usr/bin/env python3
"""One browser comparison, optionally alongside bounded test-owned disk writes.

Diagnostic only: never a qualification result, retry, cache flush or warm-up.
"""
import argparse
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time


def writer(path, seconds, cap_bytes):
    started = time.monotonic()
    written = 0
    ready = False
    block = os.urandom(1024 * 1024)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_SYNC, 0o600)
    try:
        while time.monotonic() - started < seconds and written < cap_bytes:
            if written:
                readable, _, _ = select.select([sys.stdin], [], [], 0)
                if readable and sys.stdin.buffer.read(1):
                    break
            # Reuse an owned 64-MiB file; no unbounded storage growth.
            os.lseek(fd, written % (64 * 1024 * 1024), os.SEEK_SET)
            n = os.write(fd, block)
            if n != len(block):
                raise RuntimeError("short pressure write")
            written += n
            if not ready:
                print("PRESSURE_READY", flush=True)
                ready = True
    finally:
        os.close(fd)
    print(json.dumps({"bytes_written": written, "elapsed_ms": round((time.monotonic() - started) * 1000)}), flush=True)
    return 0 if ready else 1


def run(condition, browser, command):
    if condition not in {"control", "pressure"}:
        raise ValueError("unexpected condition")
    base = pathlib.Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    browser_file = pathlib.Path(browser).resolve(strict=True)
    owned = pathlib.Path(tempfile.mkdtemp(prefix="apex-browser-io-", dir=base))
    same_device = browser_file.stat().st_dev == owned.stat().st_dev
    if condition == "pressure" and not same_device:
        print("IO_STUDY " + json.dumps({"condition": condition, "valid": False, "reason": "different_filesystems"}), flush=True)
        print("IO_STUDY_FIXTURE_ON_RUNNER " + str(owned), file=sys.stderr, flush=True)
        return 2
    worker = None
    worker_data = None
    pressure_active_at_launch = None
    pressure_active_at_exit = None
    browser_started = None
    browser_exit = None
    primary_error = None
    cleanup_error = None
    try:
        if condition == "pressure":
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
            pressure_active_at_launch = worker.poll() is None
        browser_started = time.monotonic()
        browser_process = subprocess.Popen(command)
        browser_exit = browser_process.wait()
        browser_ms = round((time.monotonic() - browser_started) * 1000)
        if worker is not None:
            pressure_active_at_exit = worker.poll() is None
    except BaseException as error:
        primary_error = error
    finally:
        if worker is not None:
            try:
                if worker.poll() is None:
                    worker.stdin.write(b"q")
                    worker.stdin.flush()
                worker.stdin.close()
                worker.stdin = None
                output, error = worker.communicate(timeout=30)
                if worker.returncode != 0:
                    raise RuntimeError("pressure worker failed: " + error[:200].decode("utf8", "replace"))
                worker_data = json.loads(output.decode("utf8").strip())
            except BaseException as error:
                cleanup_error = error
    if primary_error is not None:
        print("IO_STUDY_PRIMARY_ERROR " + type(primary_error).__name__ + ": " + str(primary_error), file=sys.stderr, flush=True)
    if cleanup_error is not None:
        print("IO_STUDY_CLEANUP_ERROR " + type(cleanup_error).__name__ + ": " + str(cleanup_error), file=sys.stderr, flush=True)
    if primary_error is not None or cleanup_error is not None:
        print("IO_STUDY_FIXTURE_ON_RUNNER " + str(owned), file=sys.stderr, flush=True)
        return 2
    valid = condition == "control" or (pressure_active_at_launch and pressure_active_at_exit)
    result = {"condition": condition, "valid": valid, "same_device": same_device,
              "browser_exit": browser_exit, "browser_total_ms": browser_ms,
              "pressure_active_at_launch": pressure_active_at_launch,
              "pressure_active_at_exit": pressure_active_at_exit, "worker": worker_data}
    print("IO_STUDY " + json.dumps(result, separators=(",", ":")), flush=True)
    return browser_exit if valid else 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--condition", choices=["control", "pressure"])
    parser.add_argument("--worker")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.worker:
        # A 2-GiB total cap completed before the first study's browser exited.
        # File size remains limited to 64 MiB; cap total writes at 8 GiB / 20 s.
        return writer(args.worker, 20, 8 * 1024 * 1024 * 1024)
    if args.self_test:
        temp = pathlib.Path(tempfile.mkdtemp(prefix="apex-pressure-selftest-"))
        file = temp / "one-block"
        try:
            result = writer(file, 0.2, 1024 * 1024)
        except BaseException:
            print("IO_STUDY_FIXTURE_ON_RUNNER " + str(temp), file=sys.stderr, flush=True)
            raise
        if result == 0:
            file.unlink()
            temp.rmdir()
        else:
            print("IO_STUDY_FIXTURE_ON_RUNNER " + str(temp), file=sys.stderr, flush=True)
        return result
    if not args.condition or sys.platform != "linux":
        raise RuntimeError("Linux and an explicit condition are required")
    return run(args.condition, "/usr/bin/chromium",
               ["python3", "test/ring7/trace_browser_ci.py", "--compare", "/usr/bin/chromium"])


if __name__ == "__main__":
    sys.exit(main())
