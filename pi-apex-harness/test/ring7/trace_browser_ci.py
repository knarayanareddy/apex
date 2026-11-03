"""Observe the owned Linux browser test tree without signaling it or logging arguments.

This runs the existing browser qualification exactly once and propagates its exit status.
Process snapshots cover early and recent samples on success or failure; they are
not evidence of unrelated PIDs.
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


def parse_cpu_ticks(text):
    try:
        fields = text[text.rindex(")") + 1:].split()
        return int(fields[11]) + int(fields[12])
    except (ValueError, IndexError):
        return None


def parse_major_faults(text):
    try:
        fields = text[text.rindex(")") + 1:].split()
        return int(fields[9])
    except (ValueError, IndexError):
        return None


def parse_io_counters(text):
    values = {}
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        value = value.strip()
        if separator and key in {"rchar", "syscr", "read_bytes"} and value.isdigit() and len(value) <= 20:
            values[key] = int(value)
    return values


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


def classify_execution(syscall_text, maps_text):
    """Return only a numeric syscall and sanitized mapped-file category/offset."""
    if not syscall_text or not maps_text:
        return {"status": "unavailable"}
    fields = syscall_text.strip().split()
    if not fields or fields[0] == "running":
        return {"status": "running"}
    try:
        syscall_number = int(fields[0])
        pc = int(fields[-1], 16)
    except (ValueError, IndexError):
        return {"status": "unavailable"}
    for line in maps_text.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        try:
            low, high = (int(x, 16) for x in parts[0].split("-", 1))
            mapped_offset = int(parts[2], 16)
        except (ValueError, IndexError):
            continue
        if not low <= pc < high:
            continue
        name = parts[5] if len(parts) == 6 else ""
        if name.startswith("/usr/local/share/chromium/") and os.path.basename(name) == "chrome":
            kind = "chromium_executable"
        elif os.environ.get("RUNNER_TEMP") and name == str(Path(os.environ["RUNNER_TEMP"]) / "apex-stage" / "chrome"):
            kind = "staged_chromium_executable"
        elif name == "/opt/google/chrome/chrome":
            kind = "google_chrome_executable"
        elif name.startswith(("/usr/lib/", "/lib/", "/lib64/")):
            kind = "system_library"
        elif not name or name.startswith("["):
            kind = "anonymous"
        else:
            kind = "other_file"
        return {"status": "mapped", "syscall": syscall_number, "kind": kind,
                "file_offset": mapped_offset + pc - low}
    return {"status": "unmapped", "syscall": syscall_number}


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
            initial[pid] = (ppid, state, started, parse_cpu_ticks(raw), parse_major_faults(raw))

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
        io_text = read_text(root / "io")
        io = parse_io_counters(io_text) if io_text is not None else None
        execution = classify_execution(read_text(root / "syscall"), read_text(root / "maps"))
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
            "start_ticks": initial[pid][2], "cpu_ticks": initial[pid][3],
            "major_faults": initial[pid][4], "io": io, "wait_channel": wait, "fds": fds,
            "active_port_file": active, "execution": execution
        })
    return {"available": True, "owned_process_count": len(owned), "browsers": browsers[:40]}


def run_observed(command, sampler=sample_owned_tree, report_always=False):
    child = subprocess.Popen(command)
    samples = collections.deque(maxlen=50)
    initial = []
    total = 0
    started = time.monotonic()
    while child.poll() is None:
        snapshot = sampler(child.pid)
        snapshot["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        if len(initial) < 50:
            initial.append(snapshot)
        samples.append((total, snapshot))
        total += 1
        time.sleep(0.5)
    code = child.returncode
    if code != 0 or report_always:
        retained = initial + [snapshot for index, snapshot in samples if index >= len(initial)]
        try:
            clock_ticks = os.sysconf("SC_CLK_TCK")
        except (ValueError, OSError):
            clock_ticks = None
        label = "BROWSER_TRACE_FAILURE " if code != 0 else "BROWSER_TRACE_DIAGNOSTIC "
        print(label + json.dumps({
            "exit": code, "clock_ticks_per_second": clock_ticks, "samples_total": total,
            "samples_retained": len(retained), "samples": retained
        }, separators=(",", ":")), file=sys.stderr, flush=True)
    else:
        print("BROWSER_TRACE_PASS: qualification passed; no failure snapshot", flush=True)
    return code if code >= 0 else 128 - code


def main():
    if sys.platform != "linux":
        print("BROWSER_TRACE_UNAVAILABLE: Linux /proc is required", file=sys.stderr)
        return 1
    if len(sys.argv) == 3 and sys.argv[1] == "--compare" and sys.argv[2] in {"/usr/bin/chromium", "/usr/bin/google-chrome"}:
        print("Running one browser binary comparison with read-only owned-process observation", flush=True)
        return run_observed(["node", "--experimental-strip-types", "test/ring7/compare-browser-binaries.ts", sys.argv[2]], report_always=True)
    if len(sys.argv) == 2 and sys.argv[1] == "--compare-staged" and os.environ.get("RUNNER_TEMP"):
        staged = Path(os.environ["RUNNER_TEMP"]) / "apex-stage" / "chrome"
        if not staged.is_file() or staged.is_symlink():
            print("BROWSER_TRACE_INVALID_STAGED_EXECUTABLE", file=sys.stderr)
            return 1
        print("Running staged executable comparison; diagnostic only", flush=True)
        return run_observed(["node", "--experimental-strip-types", "test/ring7/compare-browser-binaries.ts", str(staged)], report_always=True)
    if len(sys.argv) != 1:
        print("BROWSER_TRACE_INVALID_ARGUMENTS", file=sys.stderr)
        return 1
    print("Running npm run test:browser once with read-only owned-process observation", flush=True)
    return run_observed(["npm", "run", "test:browser"], report_always=True)


if __name__ == "__main__":
    sys.exit(main())
