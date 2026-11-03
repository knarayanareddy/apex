import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("browser_io_probe", Path(__file__).with_name("browser_io_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class BrowserIoProbeTests(unittest.TestCase):
    def test_control_runs_observer_once_and_propagates_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            browser = root / "synthetic-browser"
            browser.write_text("fixture")
            marker = root / "count"
            observer = root / "observer.py"
            observer.write_text(
                "import pathlib,sys\n"
                f"p=pathlib.Path({str(marker)!r})\n"
                "p.write_text((p.read_text() if p.exists() else '') + 'x')\n"
                "sys.exit(7)\n"
            )
            with mock.patch.dict(os.environ, {"RUNNER_TEMP": directory}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.run("control", str(observer), str(browser)), 7)
            self.assertEqual(marker.read_text(), "x")

    def test_writer_is_bounded_to_owned_file(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            target = Path(directory) / "pressure.bin"
            self.assertEqual(probe.writer(target, 1, 1024 * 1024), 0)
            self.assertEqual(target.stat().st_size, 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
