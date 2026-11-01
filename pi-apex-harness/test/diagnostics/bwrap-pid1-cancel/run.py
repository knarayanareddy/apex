#!/usr/bin/env python3
"""Throwaway Linux proof for bwrap --as-pid-1 / --sync-fd cancellation."""

from __future__ import annotations

import argparse
import fcntl
import os
import queue
import secrets
import select
import selectors
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent
DESCENDANT_LIFETIME_SECONDS = 20
NATURAL_EXIT_SAFETY_MARGIN_SECONDS = 5
PROOF_CLEANUP_ALLOWANCE_SECONDS = 6
TARGET_EXIT_DEADLINE_SECONDS = 4
OUTPUT_PER_STREAM = 256 * 1024
CONTROL_EOF_MARKER = b"CONTROL_FD_EOF\n"
NATURAL_EXIT_MARKER = b"NATURAL_CHILD_EXIT\n"
NATURAL_COMPLETION_PREFIX = b"CHILD_NATURAL_COMPLETE:"


@dataclass(frozen=True)
class Identity:
    pid: int
    start_ticks: str
    boot_id: str
    nspid: tuple[int, ...]
    pid_namespace: str
    session_id: int


class ProofRunFailure(RuntimeError):
    def __init__(
        self,
        primary_error: BaseException | None,
        cleanup_errors: list[str],
        fixture_path: Path,
    ) -> None:
        super().__init__("proof failed; test-owned fixture retained")
        self.primary_error = primary_error
        self.cleanup_errors = cleanup_errors
        self.fixture_path = fixture_path


def finish_proof_fixture(
    fixture_path: Path,
    proof_passed: bool,
    primary_error: BaseException | None,
    cleanup_errors: list[str],
    owned_processes_stopped: bool,
) -> None:
    if not proof_passed and primary_error is None:
        primary_error = RuntimeError("proof did not reach its success condition")
    if not owned_processes_stopped:
        cleanup_errors.append("owned process/thread shutdown was not confirmed; fixture retained")
    if primary_error is not None or cleanup_errors:
        failure = ProofRunFailure(primary_error, cleanup_errors, fixture_path)
        if primary_error is not None:
            raise failure from primary_error
        raise failure

    # Successful cleanup is the only path allowed to remove the fixture.
    try:
        shutil.rmtree(fixture_path)
    except BaseException as error:
        raise ProofRunFailure(
            None,
            [f"removing successful fixture failed: {error}"],
            fixture_path,
        ) from error


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_proc_stat(pid: int) -> tuple[str, str, int]:
    data = Path(f"/proc/{pid}/stat").read_text()
    close = data.rfind(")")
    if close < 0:
        raise RuntimeError(f"Malformed /proc/{pid}/stat")
    fields = data[close + 2 :].split()  # Starts at field 3 (state).
    if len(fields) <= 19:
        raise RuntimeError(f"Short /proc/{pid}/stat")
    return fields[0], fields[19], int(fields[3])  # state, starttime, session ID


def capture_identity_from_peercred(pid: int) -> Identity:
    if pid <= 0:
        raise RuntimeError(f"SO_PEERCRED returned invalid PID {pid}")
    state, start_ticks, session_id = read_proc_stat(pid)
    if state in ("Z", "X"):
        raise RuntimeError("test-owned descendant exited before identity capture")
    status = Path(f"/proc/{pid}/status").read_text()
    nspid_line = next(
        (line for line in status.splitlines() if line.startswith("NSpid:")),
        None,
    )
    if nspid_line is None:
        raise RuntimeError("captured process status has no NSpid field")
    nspid = tuple(int(value) for value in nspid_line.split()[1:])
    return Identity(
        pid=pid,
        start_ticks=start_ticks,
        boot_id=Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        nspid=nspid,
        pid_namespace=os.readlink(f"/proc/{pid}/ns/pid"),
        session_id=session_id,
    )


def serve_peercred(
    listener: socket.socket,
    stop: threading.Event,
    result: queue.Queue[Identity | BaseException],
) -> None:
    deadline = time.monotonic() + 10
    try:
        while not stop.is_set() and time.monotonic() < deadline:
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                continue
            with connection:
                connection.settimeout(3)
                if connection.recv(1) != b"x":
                    raise RuntimeError("test-owned descendant sent an invalid identity handshake")
                size = struct.calcsize("3i")
                peer_pid, peer_uid, _peer_gid = struct.unpack(
                    "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size)
                )
                if peer_uid != os.getuid():
                    raise RuntimeError("SO_PEERCRED uid did not match the test owner")
                identity = capture_identity_from_peercred(peer_pid)
                connection.sendall(b"1")
                result.put(identity)
                return
        if not stop.is_set():
            raise TimeoutError("test-owned descendant did not connect to the identity socket")
    except BaseException as error:
        if not stop.is_set():
            result.put(error)


def assert_no_control_pipe_in_descendant(identity: Identity, pipe_inode: int) -> None:
    expected = f"pipe:[{pipe_inode}]"
    fd_dir = Path(f"/proc/{identity.pid}/fd")
    for fd in fd_dir.iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        require(
            target != expected,
            f"captured shell PID {identity.pid} inherited control pipe on fd {fd.name}",
        )


def captured_identity_alive(identity: Identity) -> bool:
    current_boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if current_boot_id != identity.boot_id:
        return False
    try:
        state, start_ticks, _session_id = read_proc_stat(identity.pid)
    except FileNotFoundError:
        return False
    if start_ticks != identity.start_ticks:
        return False  # The original process is gone; the numeric PID was reused.
    return state != "Z"


def before_natural_exit_cutoff(observed_at: float, spawn_started_at: float) -> bool:
    cutoff = spawn_started_at + DESCENDANT_LIFETIME_SECONDS - NATURAL_EXIT_SAFETY_MARGIN_SECONDS
    return observed_at < cutoff


def cancellation_success(
    exit_code: int | None,
    markers: set[bytes],
    descendant_alive: bool,
    observed_at: float,
    spawn_started_at: float,
) -> bool:
    return (
        exit_code == 0
        and CONTROL_EOF_MARKER in markers
        and NATURAL_EXIT_MARKER not in markers
        and not any(marker.startswith(NATURAL_COMPLETION_PREFIX) for marker in markers)
        and not descendant_alive
        and before_natural_exit_cutoff(observed_at, spawn_started_at)
    )


def classifier_control_only() -> None:
    """Synthetic negative controls for the Linux runner's success predicate and deadline."""
    spawn_at = 100.0
    require(
        cancellation_success(0, {CONTROL_EOF_MARKER}, False, 114.0, spawn_at),
        "synthetic EOF case should satisfy the cancellation predicate",
    )
    require(
        not cancellation_success(42, {NATURAL_EXIT_MARKER}, False, 110.0, spawn_at),
        "natural child exit/status must not satisfy cancellation success",
    )
    require(
        not cancellation_success(0, {NATURAL_EXIT_MARKER}, False, 110.0, spawn_at),
        "a natural-exit marker must reject even a synthetic zero status",
    )
    require(
        not cancellation_success(0, {NATURAL_COMPLETION_PREFIX + b"test\n"}, False, 110.0, spawn_at),
        "a natural-completion marker must reject cancellation success",
    )
    require(
        not cancellation_success(0, set(), False, 110.0, spawn_at),
        "zero exit without the EOF-specific marker must not satisfy cancellation",
    )
    require(
        not cancellation_success(0, {CONTROL_EOF_MARKER}, True, 110.0, spawn_at),
        "EOF marker cannot pass while the captured descendant is alive",
    )
    require(
        not before_natural_exit_cutoff(115.0, spawn_at),
        "observation at the safety cutoff must fail",
    )
    require(
        not cancellation_success(0, {CONTROL_EOF_MARKER}, False, 115.001, spawn_at),
        "observation outside the permitted lifetime margin must fail",
    )
    print("PASS: synthetic natural-exit outcome cannot satisfy the cancellation success predicate")


def evidence_control_only() -> None:
    """Exercise retention and primary-versus-cleanup error reporting without bwrap."""
    root_path = Path(tempfile.mkdtemp(prefix="bwrap-proof-evidence-control-"))
    passed = False
    try:
        failed_fixture = root_path / "failed-fixture"
        failed_fixture.mkdir()
        primary = AssertionError("synthetic primary assertion")
        try:
            finish_proof_fixture(
                failed_fixture,
                False,
                primary,
                ["synthetic cleanup failure"],
                False,
            )
        except ProofRunFailure as failure:
            require(failure.primary_error is primary, "primary error was not preserved")
            require(
                failure.cleanup_errors == [
                    "synthetic cleanup failure",
                    "owned process/thread shutdown was not confirmed; fixture retained",
                ],
                "cleanup errors were not reported separately",
            )
            require(failure.fixture_path == failed_fixture and failed_fixture.exists(), "failed fixture was not retained")
        else:
            raise AssertionError("synthetic failure did not retain its fixture")

        successful_fixture = root_path / "successful-fixture"
        successful_fixture.mkdir()
        finish_proof_fixture(successful_fixture, True, None, [], True)
        require(not successful_fixture.exists(), "successful stopped fixture was not cleaned")

        running_fixture = root_path / "not-stopped-fixture"
        running_fixture.mkdir()
        try:
            finish_proof_fixture(running_fixture, True, None, [], False)
        except ProofRunFailure as failure:
            require(running_fixture.exists(), "fixture was removed before owned shutdown was confirmed")
            require(failure.primary_error is None and bool(failure.cleanup_errors), "shutdown failure was not reported")
        else:
            raise AssertionError("fixture was removed without confirmed process shutdown")
        passed = True
    finally:
        if passed:
            shutil.rmtree(root_path)
        else:
            print(f"FAIL: evidence control fixture retained: {root_path}", file=sys.stderr)
    print("PASS: failed evidence is retained; primary/cleanup errors stay separate; cleanup requires success and stopped owners")


def pipe_control_only() -> None:
    """Portable EOF control: a forked writer keeps EOF away until it closes."""
    read_fd, write_fd = os.pipe()
    release_read, release_write = os.pipe()
    ready_read, ready_write = os.pipe()
    child = os.fork()
    child_reaped = False
    if child == 0:
        try:
            os.close(read_fd)
            os.close(release_write)
            os.close(ready_read)
            os.write(ready_write, b"R")
            os.close(ready_write)
            if os.read(release_read, 1) != b"X":
                os._exit(2)
            os.close(write_fd)
            os._exit(0)
        except BaseException:
            os._exit(3)

    os.close(release_read)
    os.close(ready_write)
    try:
        require(os.read(ready_read, 1) == b"R", "pipe-control child failed to start")
        os.close(ready_read)
        ready_read = -1
        os.close(write_fd)  # Parent closes only its own writer reference.
        write_fd = -1
        readable, _, _ = select.select([read_fd], [], [], 0.1)
        require(not readable, "pipe reached EOF while child still held a writer")
        os.write(release_write, b"X")
        os.close(release_write)
        release_write = -1
        require(os.read(read_fd, 1) == b"", "EOF did not arrive after last writer closed")
        _, status = os.waitpid(child, 0)
        child_reaped = True
        require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, "pipe-control child failed")
        print("PASS: closing the parent's writer is not EOF while a child holds a writer; EOF follows its close")
    finally:
        # Always release and reap the test-owned child; no signals are sent.
        if release_write >= 0:
            try:
                os.write(release_write, b"X")
            except OSError:
                pass
        for fd in (read_fd, write_fd, release_write, ready_read):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if not child_reaped:
            os.waitpid(child, 0)


class Drain:
    def __init__(
        self,
        selector: selectors.BaseSelector,
        stdout_fd: int,
        stderr_fd: int,
        markers: tuple[bytes, ...],
    ):
        self.selector = selector
        self.markers = markers
        self.markers_seen: set[bytes] = set()
        self.counts = {stdout_fd: 0, stderr_fd: 0}
        self.tails = {stdout_fd: bytearray(), stderr_fd: bytearray()}
        for fd in (stdout_fd, stderr_fd):
            os.set_blocking(fd, False)
            selector.register(fd, selectors.EVENT_READ)

    def pump(self, timeout: float) -> None:
        for key, _ in self.selector.select(timeout):
            fd = key.fd
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if not chunk:
                self.selector.unregister(fd)
                os.close(fd)
                continue
            self.counts[fd] += len(chunk)
            tail = self.tails[fd]
            combined = tail + chunk
            for marker in self.markers:
                if marker in combined:
                    self.markers_seen.add(marker)
            tail.extend(chunk)
            if len(tail) > 4096:
                del tail[:-4096]

    def has_marker(self, marker: bytes) -> bool:
        return marker in self.markers_seen


def compile_supervisor(output: Path) -> None:
    compiler = shutil.which("cc")
    if compiler is None:
        raise RuntimeError("A C compiler ('cc') is required for the Linux proof")
    subprocess.run(
        [
            compiler,
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            str(HERE / "pid1_supervisor.c"),
            "-o",
            str(output),
        ],
        check=True,
    )


def run_linux_proof() -> None:
    if sys.platform != "linux":
        raise RuntimeError("Linux-only proof not run: this host is not Linux")
    bwrap = shutil.which("bwrap")
    if bwrap is None:
        raise RuntimeError("Linux-only proof not run: bwrap is not installed")
    if not Path("/proc/self/status").exists():
        raise RuntimeError("Linux-only proof needs procfs mounted at /proc")
    for required_path in ("/usr", "/bin", "/lib"):
        if not Path(required_path).exists():
            raise RuntimeError(f"Linux proof requires host path {required_path}")

    token = f"pid1-cancel-{os.getpid()}-{secrets.token_hex(8)}"
    child_pid: int | None = None
    control_write: int | None = None
    drain: Drain | None = None
    selector = selectors.DefaultSelector()
    reaped_status: int | None = None
    listener: socket.socket | None = None
    server_stop = threading.Event()
    identity_results: queue.Queue[Identity | BaseException] = queue.Queue(maxsize=1)
    server_thread: threading.Thread | None = None
    temp_dir = Path(tempfile.mkdtemp(prefix="bwrap-pid1-proof-"))
    primary_error: BaseException | None = None
    cleanup_errors: list[str] = []
    proof_passed = False
    control_read = control_write = -1
    stdout_read = stdout_write = -1
    stderr_read = stderr_write = -1
    fd3_guard = -1

    try:
        supervisor = temp_dir / "pid1-supervisor"
        identity_dir = temp_dir / "identity"
        identity_dir.mkdir()
        socket_path = identity_dir / "peer.sock"
        if len(os.fsencode(socket_path)) >= 108:
            raise RuntimeError("temporary Unix socket path exceeds Linux sun_path capacity")
        shell_ready_marker = f"DESCENDANT_READY:{token}\n".encode()
        natural_completion_marker = f"CHILD_NATURAL_COMPLETE:{token}\n".encode()
        markers = (
            shell_ready_marker,
            CONTROL_EOF_MARKER,
            NATURAL_EXIT_MARKER,
            natural_completion_marker,
        )
        compile_supervisor(supervisor)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        listener.listen(1)
        listener.settimeout(0.1)
        server_thread = threading.Thread(
            target=serve_peercred,
            args=(listener, server_stop, identity_results),
            name="test-owned-peercred-server",
            daemon=True,
        )
        server_thread.start()
        control_read, control_write = os.pipe()
        pipe_inode = os.fstat(control_read).st_ino
        if control_read == 3:
            moved = fcntl.fcntl(control_read, fcntl.F_DUPFD_CLOEXEC, 10)
            os.close(control_read)
            control_read = moved
            fd3_guard = os.open(os.devnull, os.O_RDONLY)
            require(fd3_guard == 3, f"failed to reserve child descriptor 3 (got {fd3_guard})")
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        actions = [
            (os.POSIX_SPAWN_DUP2, control_read, 3),
            (os.POSIX_SPAWN_DUP2, stdout_write, 1),
            (os.POSIX_SPAWN_DUP2, stderr_write, 2),
        ]
        for fd in (control_read, control_write, stdout_read, stdout_write, stderr_read, stderr_write):
            if fd not in (1, 2, 3):
                actions.append((os.POSIX_SPAWN_CLOSE, fd))
        argv = [
            bwrap,
            "--unshare-user",
            "--unshare-pid",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/bin",
            "/bin",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--dir",
            "/proof",
            "--ro-bind",
            str(supervisor),
            "/proof/pid1-supervisor",
            "--ro-bind",
            str(identity_dir),
            "/proof/identity",
            "--as-pid-1",
            "--sync-fd",
            "3",
            "--die-with-parent",
            "--clearenv",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--",
            "/proof/pid1-supervisor",
            token,
            "/proof/identity/peer.sock",
        ]
        # The shell's earliest natural completion is 20 seconds after exec,
        # which cannot precede this timestamp. Require success before +15s.
        spawn_started_at = time.monotonic()
        natural_exit_cutoff = (
            spawn_started_at
            + DESCENDANT_LIFETIME_SECONDS
            - NATURAL_EXIT_SAFETY_MARGIN_SECONDS
        )
        child_pid = os.posix_spawn(bwrap, argv, os.environ.copy(), file_actions=actions)
        os.close(control_read)
        control_read = -1
        os.close(stdout_write)
        stdout_write = -1
        os.close(stderr_write)
        stderr_write = -1
        if fd3_guard >= 0:
            os.close(fd3_guard)
            fd3_guard = -1
        drain = Drain(selector, stdout_read, stderr_read, markers)
        stdout_read = stderr_read = -1

        deadline = min(time.monotonic() + 6, natural_exit_cutoff)
        identity: Identity | None = None
        while time.monotonic() < deadline:
            drain.pump(0.05)
            if identity is None:
                try:
                    identity_result = identity_results.get_nowait()
                except queue.Empty:
                    pass
                else:
                    if isinstance(identity_result, BaseException):
                        raise RuntimeError(f"SO_PEERCRED identity capture failed: {identity_result}")
                    identity = identity_result
            if drain.has_marker(shell_ready_marker) and identity is not None:
                break
        require(identity is not None, "did not capture the SO_PEERCRED descendant identity")
        assert identity is not None
        require(captured_identity_alive(identity), "captured shell identity changed before cancellation")
        require(len(identity.nspid) >= 2, "SO_PEERCRED process is not in a nested PID namespace")
        require(
            identity.nspid[-1] > 1,
            "SO_PEERCRED process unexpectedly occupies PID 1 rather than being the child",
        )
        require(
            identity.pid_namespace != os.readlink("/proc/self/ns/pid"),
            "SO_PEERCRED process is not in a distinct PID namespace",
        )
        require(identity.session_id == identity.pid, "captured descendant is not its setsid session leader")
        assert_no_control_pipe_in_descendant(identity, pipe_inode)
        require(
            captured_identity_alive(identity),
            "captured descendant exited naturally immediately before control EOF",
        )
        require(
            time.monotonic() < natural_exit_cutoff,
            "control EOF would occur outside the required natural-exit safety margin",
        )

        # Cancellation action: close only our control-pipe writer. No process
        # or process-group signal is issued anywhere in this proof.
        os.close(control_write)
        control_write = None

        deadline = min(time.monotonic() + TARGET_EXIT_DEADLINE_SECONDS, natural_exit_cutoff)
        while time.monotonic() < deadline and captured_identity_alive(identity):
            drain.pump(0.05)
        require(
            not captured_identity_alive(identity),
            f"specific descendant identity PID={identity.pid}, start={identity.start_ticks} survived control EOF",
        )

        deadline = min(time.monotonic() + TARGET_EXIT_DEADLINE_SECONDS, natural_exit_cutoff)
        while reaped_status is None and time.monotonic() < deadline:
            drain.pump(0.05)
            waited, status = os.waitpid(child_pid, os.WNOHANG)
            if waited == child_pid:
                reaped_status = status
        require(reaped_status is not None, "bwrap did not exit promptly after PID 1 terminated")
        assert reaped_status is not None

        deadline = min(time.monotonic() + 2, natural_exit_cutoff)
        while selector.get_map() and time.monotonic() < deadline:
            drain.pump(0.05)
        require(not selector.get_map(), "stdout/stderr remained open after bwrap and descendant exit")
        counts = list(drain.counts.values())
        require(all(count >= OUTPUT_PER_STREAM for count in counts), f"output drain too small: {counts}")
        exit_code = os.WEXITSTATUS(reaped_status) if os.WIFEXITED(reaped_status) else None
        descendant_alive = captured_identity_alive(identity)
        final_observation_at = time.monotonic()
        require(
            cancellation_success(
                exit_code,
                drain.markers_seen,
                descendant_alive,
                final_observation_at,
                spawn_started_at,
            ),
            "cancellation evidence failed: "
            f"exit_code={exit_code}, markers={sorted(drain.markers_seen)!r}, "
            f"descendant_alive={descendant_alive}, observed_at={final_observation_at:.6f}, "
            f"cutoff={natural_exit_cutoff:.6f}",
        )
        print(
            "PASS: parent writer EOF exited test PID 1; kernel ended the captured setsid shell; "
            f"stdout/stderr drained ({counts[0]}/{counts[1]} bytes)."
        )
        proof_passed = True
    except BaseException as error:
        primary_error = error
    finally:
        if control_write is not None and control_write >= 0:
            try:
                os.close(control_write)
            except BaseException as error:
                cleanup_errors.append(f"closing control writer failed: {error}")
            control_write = None
        try:
            server_stop.set()
        except BaseException as error:
            cleanup_errors.append(f"stopping identity server failed: {error}")
        if listener is not None:
            try:
                listener.close()
            except BaseException as error:
                cleanup_errors.append(f"closing identity listener failed: {error}")
        if server_thread is not None and server_thread.ident is not None:
            try:
                server_thread.join(timeout=4)
                if server_thread.is_alive():
                    cleanup_errors.append("test-owned SO_PEERCRED server did not stop within 4 seconds")
            except BaseException as error:
                cleanup_errors.append(f"joining identity server failed: {error}")

        if child_pid is not None and reaped_status is None:
            cleanup_deadline = (
                time.monotonic()
                + DESCENDANT_LIFETIME_SECONDS
                + PROOF_CLEANUP_ALLOWANCE_SECONDS
            )
            drain_usable = True
            while time.monotonic() < cleanup_deadline:
                try:
                    has_output_fds = bool(selector.get_map())
                except BaseException as error:
                    cleanup_errors.append(f"checking output descriptors during cleanup failed: {error}")
                    has_output_fds = False
                    drain_usable = False
                if drain_usable and drain is not None and has_output_fds:
                    try:
                        drain.pump(0.05)
                    except BaseException as error:
                        cleanup_errors.append(f"draining output during cleanup failed: {error}")
                        drain_usable = False
                try:
                    waited, status = os.waitpid(child_pid, os.WNOHANG)
                except BaseException as error:
                    cleanup_errors.append(f"waiting for test-owned bwrap failed: {error}")
                    break
                if waited == child_pid:
                    reaped_status = status
                    break
            if reaped_status is None:
                cleanup_errors.append("could not reap test-owned bwrap within 26 seconds; no signal was sent")

        for fd in (control_read, fd3_guard, stdout_read, stdout_write, stderr_read, stderr_write):
            if fd >= 0:
                try:
                    os.close(fd)
                except BaseException as error:
                    cleanup_errors.append(f"closing owned fd {fd} failed: {error}")
        try:
            registered_output_keys = list(selector.get_map().values())
        except BaseException as error:
            cleanup_errors.append(f"enumerating owned output descriptors failed: {error}")
            registered_output_keys = []
        for key in registered_output_keys:
            try:
                selector.unregister(key.fd)
                os.close(key.fd)
            except BaseException as error:
                cleanup_errors.append(f"closing captured output fd {key.fd} failed: {error}")
        try:
            selector.close()
        except BaseException as error:
            cleanup_errors.append(f"closing output selector failed: {error}")

    owned_processes_stopped = (child_pid is None or reaped_status is not None) and (
        server_thread is None or server_thread.ident is None or not server_thread.is_alive()
    )
    finish_proof_fixture(
        temp_dir,
        proof_passed,
        primary_error,
        cleanup_errors,
        owned_processes_stopped,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pipe-control-only",
        action="store_true",
        help="run only the platform-independent inherited-writer EOF control",
    )
    parser.add_argument(
        "--classifier-control-only",
        action="store_true",
        help="run only the synthetic natural-exit rejection control",
    )
    parser.add_argument(
        "--evidence-control-only",
        action="store_true",
        help="run only the synthetic fixture-retention/error-reporting control",
    )
    args = parser.parse_args()
    try:
        if args.pipe_control_only:
            pipe_control_only()
        elif args.classifier_control_only:
            classifier_control_only()
        elif args.evidence_control_only:
            evidence_control_only()
        else:
            run_linux_proof()
    except ProofRunFailure as failure:
        if failure.primary_error is not None:
            print(f"PRIMARY ERROR: {type(failure.primary_error).__name__}: {failure.primary_error}", file=sys.stderr)
        else:
            print("PRIMARY ERROR: none (proof passed; fixture cleanup failed)", file=sys.stderr)
        for cleanup_error in failure.cleanup_errors:
            print(f"CLEANUP ERROR: {cleanup_error}", file=sys.stderr)
        print(f"RETAINED FIXTURE: {failure.fixture_path}", file=sys.stderr)
        return 1
    except (AssertionError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
