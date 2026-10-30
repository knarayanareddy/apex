import json
import os
import subprocess
import sys
import tempfile
import unittest
import inspect
import contextlib
import io
from pathlib import Path

import trace_browser_ci as trace
from trace_browser_ci import classify_fd, descendants, parse_stat, run_observed, sample_owned_tree


class BrowserTraceTests(unittest.TestCase):
    def test_stat_parser_handles_parentheses_in_process_name(self):
        fields = ["S", "10"] + ["0"] * 17 + ["12345"]
        stat = "420 (chrome (worker)) " + " ".join(fields)
        self.assertEqual(parse_stat(stat), (420, 10, "S", 12345))
        self.assertIsNone(parse_stat("broken"))

    def test_cpu_and_io_counters_are_numeric_only(self):
        fields = ["S", "10"] + ["0"] * 17 + ["12345"]
        fields[11], fields[12] = "25", "17"
        parser = getattr(trace, "parse_cpu_ticks", lambda _text: None)
        self.assertEqual(parser("420 (chrome) " + " ".join(fields)), 42)
        self.assertIsNone(parser("broken"))
        fields[9] = "3"
        parse_faults = getattr(trace, "parse_major_faults", lambda _text: None)
        self.assertEqual(parse_faults("420 (chrome) " + " ".join(fields)), 3)
        self.assertIsNone(parse_faults("broken"))
        parse_io = getattr(trace, "parse_io_counters", lambda _text: {})
        self.assertEqual(parse_io("rchar: 12\nsyscr: 3\nread_bytes: 8192\nignored: secret\n"), {"rchar": 12, "syscr": 3, "read_bytes": 8192})

    def test_descendants_exclude_unrelated_processes(self):
        self.assertEqual(descendants(11, {11: 1, 12: 11, 13: 12, 900: 77}), {11, 12, 13})

    def test_fd_classification_never_returns_paths_or_inodes(self):
        self.assertEqual(classify_fd("pipe:[123]"), "pipe")
        self.assertEqual(classify_fd("socket:[456]"), "socket")
        self.assertEqual(classify_fd("/home/private/.ssh/id_ed25519"), "file")

    def test_snapshot_is_owned_and_does_not_emit_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc = root / "proc"
            proc.mkdir()
            profile = root / "pi-apex-cdp-synthetic"
            profile.mkdir()
            (profile / "DevToolsActivePort").write_text("9222\n/private-capability\n")
            for pid, ppid, name in [(100, 1, "node"), (101, 100, "chromium"), (999, 7, "chromium")]:
                entry = proc / str(pid)
                (entry / "fd").mkdir(parents=True)
                fields = ["S", str(ppid)] + ["0"] * 17 + [str(pid + 1000)]
                (entry / "stat").write_text(f"{pid} ({name}) " + " ".join(fields))
                (entry / "comm").write_text(name + "\n")
                (entry / "wchan").write_text("futex_wait\n")
                (entry / "io").write_text("rchar: 12\nsyscr: 3\nread_bytes: 8192\nignored: synthetic-secret\n")
                command = b"/usr/bin/node\0" if name == "node" else b"/usr/bin/chromium\0--private=synthetic-secret\0--user-data-dir=" + os.fsencode(profile) + b"\0"
                (entry / "cmdline").write_bytes(command)
                (entry / "fd" / "1").symlink_to("/private/path")
                (entry / "fd" / "2").symlink_to("pipe:[123]")
            old_tmp = os.environ.get("TMPDIR")
            os.environ["TMPDIR"] = str(root)
            try:
                result = sample_owned_tree(100, proc)
            finally:
                if old_tmp is None:
                    os.environ.pop("TMPDIR", None)
                else:
                    os.environ["TMPDIR"] = old_tmp
            self.assertEqual([item["pid"] for item in result["browsers"]], [101])
            self.assertEqual(result["browsers"][0]["active_port_file"], True)
            self.assertEqual(result["browsers"][0]["fds"], {"1": "file", "2": "pipe"})
            self.assertEqual(result["browsers"][0]["io"], {"rchar": 12, "syscr": 3, "read_bytes": 8192})
            encoded = json.dumps(result)
            self.assertNotIn("synthetic-secret", encoded)
            self.assertNotIn("/private", encoded)

    def test_observer_runs_once_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "count"
            code = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text((p.read_text() if p.exists() else '') + 'x'); sys.exit(7)"
            result = run_observed([sys.executable, "-c", code, str(marker)], sampler=lambda _pid: {"available": False})
            self.assertEqual(result, 7)
            self.assertEqual(marker.read_text(), "x")

    def test_successful_diagnostic_can_report_samples(self):
        self.assertIn("report_always", inspect.signature(run_observed).parameters)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = run_observed([sys.executable, "-c", "raise SystemExit(0)"], sampler=lambda _pid: {"available": False}, report_always=True)
        self.assertEqual(result, 0)
        self.assertIn("BROWSER_TRACE_DIAGNOSTIC", output.getvalue())

    def test_required_comparison_fails_if_browser_is_missing(self):
        script = Path(__file__).with_name("compare-browser-binaries.ts")
        env = dict(os.environ, APEX_COMPARE_REQUIRE_SUCCESS="1")
        result = subprocess.run(["node", "--experimental-strip-types", str(script), "/nonexistent/apex-synthetic-browser"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"available":false', result.stdout)

    def test_required_comparison_fails_if_browser_exits(self):
        script = Path(__file__).with_name("compare-browser-binaries.ts")
        with tempfile.TemporaryDirectory() as directory:
            browser = Path(directory) / "fake-browser"
            browser.write_text("#!/bin/sh\nexit 23\n")
            browser.chmod(0o700)
            env = dict(os.environ, APEX_COMPARE_REQUIRE_SUCCESS="1")
            result = subprocess.run(["node", "--experimental-strip-types", str(script), str(browser)], env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"ok":false', result.stdout)

    def test_nonrequired_missing_comparison_is_diagnostic(self):
        script = Path(__file__).with_name("compare-browser-binaries.ts")
        env = dict(os.environ)
        env.pop("APEX_COMPARE_REQUIRE_SUCCESS", None)
        result = subprocess.run(["node", "--experimental-strip-types", str(script), "/nonexistent/apex-synthetic-browser"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('"available":false', result.stdout)

    def test_required_comparison_bounds_a_hung_target_request(self):
        script = Path(__file__).with_name("compare-browser-binaries.ts")
        with tempfile.TemporaryDirectory() as directory:
            browser = Path(directory) / "fake-browser"
            marker = Path(directory) / "request-observed"
            marker_js = json.dumps(str(marker))
            browser.write_text(
                "#!/usr/bin/env node\n"
                "const http=require('node:http'), fs=require('node:fs');\n"
                f"const server=http.createServer(() => fs.writeFileSync({marker_js}, 'seen'));\n"
                "server.listen(0, '127.0.0.1', () => process.stderr.write("
                "`DevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/test\\n`));\n"
                "setTimeout(() => process.exit(0), 4000);\n"
            )
            browser.chmod(0o700)
            env = dict(os.environ, APEX_COMPARE_REQUIRE_SUCCESS="1", APEX_COMPARE_TIMEOUT_MS="2000")
            result = subprocess.run(["node", "--experimental-strip-types", str(script), str(browser)], env=env, capture_output=True, text=True, timeout=8)
            self.assertTrue(marker.exists(), "The synthetic browser must reach the stalled HTTP request")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"errorCode":"BROWSER_COMPARISON_TIMEOUT"', result.stdout)


if __name__ == "__main__":
    unittest.main()
