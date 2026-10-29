"""Observe the owned Linux browser test tree without signaling it or logging arguments.

This runs the existing browser qualification exactly once and propagates its exit status.
Process snapshots are reported only on failure; they are not evidence of unrelated PIDs.
"""
import collections
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path


def parse_stat(text):
    try:
        left = text.index(" (")
        right = text.rindex(")")
        pid = int(text[:left])
        fields = text[right + 1:].split()
        return pid, int(fields[1]), fields[0], int(fields[19])
    except (ValueError, IndexError):
        return None


def descendants(root, parents):
    found = {root}
    pending = [root]
    while pending:
        parent = pending.pop()
        for child, candidate in parents.items():
            if candidate == parent and child not in found:
                found.add(child)
                pending.append(child)
    return found


def classify_fd(target):
    if target.startswith("pipe:["):
        return "pipe"
    if target.startswith("socket:["):
        return "socket"
    if target.startswith("anon_inode:"):
        return "anon_inode"
    return "file"


def read_text(path):
    try:
        return path.read_text(encoding="utf8", errors="replace")
    except OSError:
        return None


def sample_owned_tree(root_pid, proc=Path("/proc")):
    if not proc.is_dir():
        return {"available": False, "reason": "proc_unavailable"}
    parents = {}
    initial = {}
    try:
        entries = list(proc.iterdir())
    except OSError:
        return {"available": False, "reason": "proc_unreadable"}
    for entry in entries:
        if not entry.name.isdigit():
            continue
        raw = read_text(entry / "stat")
        item = parse_stat(raw) if raw else None
        if item:
            pid, ppid, state, started = item
            parents[pid] = ppid
            initial[pid] = (ppid, state, started)

    owned = descendants(root_pid, parents)
    browsers = []
    for pid in sorted(owned):
        if pid not in initial:
            continue
        root = proc / str(pid)
        comm = read_text(root / "comm")
        try:
            argv = (root / "cmdline").read_bytes().split(b"\0")
        except OSError:
            argv = []
        # Arguments are used only to classify an owned process; never emit them.
        browser_names = {b"chromium", b"chromium-browser", b"google-chrome", b"google-chrome-stable", b"chrome", b"chromium-with-stdout", b"synthetic-chromium"}
        is_browser = bool(comm and "chrom" in comm.lower()) or any(
            os.path.basename(part).lower() in browser_names for part in argv[:2] if part
        )
        if not is_browser:
            continue
        profile = None
        for arg in argv:
            if arg.startswith(b"--user-data-dir="):
                profile = os.fsdecode(arg.split(b"=", 1)[1])
                break
        active = "unavailable"
        if profile:
            try:
                temp = Path(os.environ.get("TMPDIR", "/tmp")).resolve()
                directory = Path(profile).resolve()
                if directory.parent == temp and directory.name.startswith("pi-apex-cdp-"):
                    try:
                        active = stat.S_ISREG((directory / "DevToolsActivePort").lstat().st_mode)
                    except FileNotFoundError:
                        active = False
            except OSError:
                pass
        wait = read_text(root / "wchan")
        wait = re.sub(r"[^a-zA-Z0-9_.-]", "_", wait.strip())[:64] if wait else "unavailable"
        fds = {}
        for number in (1, 2):
            try:
                fds[str(number)] = classify_fd(os.readlink(root / "fd" / str(number)))
            except OSError:
                fds[str(number)] = "unavailable"
        final_raw = read_text(root / "stat")
        final = parse_stat(final_raw) if final_raw else None
        if not final or final[3] != initial[pid][2]:
            continue  # PID disappeared or changed while being sampled.
        browsers.append({
            "pid": pid, "ppid": initial[pid][0], "state": initial[pid][1],
            "start_ticks": initial[pid][2], "wait_channel": wait, "fds": fds,
            "active_port_file": active
        })
    return {"available": True, "owned_process_count": len(owned), "browsers": browsers[:40]}


def run_observed(command, sampler=sample_owned_tree):
    child = subprocess.Popen(command)
    samples = collections.deque(maxlen=50)
    total = 0
    started = time.monotonic()
    while child.poll() is None:
        snapshot = sampler(child.pid)
        snapshot["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        samples.append(snapshot)
        total += 1
        time.sleep(0.5)
    code = child.returncode
    if code != 0:
        print("BROWSER_TRACE_FAILURE " + json.dumps({
            "exit": code, "samples_total": total, "samples_retained": len(samples), "samples": list(samples)
        }, separators=(",", ":")), file=sys.stderr, flush=True)
    else:
        print("BROWSER_TRACE_PASS: qualification passed; no failure snapshot", flush=True)
    return code if code >= 0 else 128 - code


def main():
    if sys.platform != "linux":
        print("BROWSER_TRACE_UNAVAILABLE: Linux /proc is required", file=sys.stderr)
        return 1
    print("Running npm run test:browser once with read-only owned-process observation", flush=True)
    return run_observed(["npm", "run", "test:browser"])


if __name__ == "__main__":
    sys.exit(main())
