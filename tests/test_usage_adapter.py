import contextlib
import datetime
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/agy-usage-adapter.py"
spec = importlib.util.spec_from_file_location("usage_adapter", SCRIPT)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

# Anonymized layout from the official 1.5.17 CLI, not a model response.
PANEL = """Eligibility check failed: not currently available in your location.
└ Models & Quota
Account: fixture@example.com
GEMINI MODELS
  Weekly Limit Remaining
    [████░░] 89.53%
    Refreshes in 5d 14h 2m
  Five Hour Limit Remaining
    [██████] 99.31%
    Refreshes in 4h 30m
CLAUDE AND GPT MODELS
  Weekly Limit Remaining
    [██████] 100.00%
    Quota available
  Five Hour Limit Remaining
    [██████] 100.00%
    Quota available
"""


class UsageAdapterTest(unittest.TestCase):
    def test_real_layout_preserves_percent_and_minute_resolution_reset(self):
        now = datetime.datetime(2026, 11, 25, tzinfo=datetime.timezone.utc)
        report = adapter.parse_quota(PANEL, now)
        self.assertEqual(report["status"], "SUCCESS")
        groups = report["command"]["data"]["groups"]
        self.assertEqual(len(groups), 2)
        self.assertEqual(groups[0]["buckets"][0]["remaining_fraction"], 0.8953)
        self.assertEqual(groups[0]["buckets"][1]["remaining_fraction"], 0.9931)
        self.assertEqual(groups[0]["buckets"][0]["reset_time"], "2026-11-30T14:02:00+00:00")
        self.assertEqual(groups[1]["buckets"][0]["remaining_fraction"], 1)
        self.assertIsNone(groups[1]["buckets"][0]["reset_time"])
        self.assertNotIn("fixture@example.com", json.dumps(report))

    def test_warning_partial_duplicate_and_unfamiliar_panels_fail_closed(self):
        for text in (
            "Eligibility check failed: unavailable in your location.",
            PANEL[:PANEL.index("CLAUDE AND GPT MODELS")],
            PANEL.rsplit("Quota available", 1)[0],
            PANEL.replace("99.31%", "unknown"),
            PANEL + PANEL[PANEL.index("GEMINI MODELS"):],
            PANEL.replace("GEMINI MODELS", "UNKNOWN MODELS"),
        ):
            with self.subTest(text=text[:60]):
                self.assertIsNone(adapter.parse_quota(text))

    def test_invalid_percent_and_overflowing_reset_are_rejected(self):
        for percent in ("199.31%", "-1.00%", "NaN%"):
            self.assertIsNone(adapter.parse_quota(PANEL.replace("99.31%", percent)))
        self.assertIsNone(adapter.parse_quota(PANEL.replace("5d 14h 2m", "999999999999999999999d")))

    def test_ansi_and_carriage_returns_do_not_change_parsed_quota(self):
        raw = ("\x1b[31m" + PANEL.replace("\n", "\r\n") + "\x1b[0m").encode()
        self.assertEqual(adapter.plain_text(raw), PANEL)
        self.assertIsNotNone(adapter.parse_quota(adapter.plain_text(raw)))

    def invoke_failure(self, error):
        output = io.StringIO()
        with mock.patch.object(adapter.sys, "argv", [str(SCRIPT), "-p", "/usage", "--output-format", "json"]), \
                mock.patch.object(adapter, "interactive_usage", side_effect=error), \
                mock.patch.object(adapter.signal, "signal"), contextlib.redirect_stdout(output):
            code = adapter.main()
        return code, json.loads(output.getvalue())

    def test_query_failure_is_structured_even_for_older_plugin_readers(self):
        code, data = self.invoke_failure(RuntimeError("Complete agy setup first."))
        self.assertEqual(code, 0)
        self.assertEqual(data, {"status": "ERROR", "error": "Complete agy setup first."})

    def test_os_failure_never_exposes_paths_or_raw_output(self):
        code, data = self.invoke_failure(OSError(5, "private@example.com /private/credential"))
        self.assertEqual(code, 0)
        self.assertEqual(data["status"], "ERROR")
        self.assertNotIn("private", data["error"])

    def test_acp_version_and_non_usage_invocations_exec_the_original_argv(self):
        class Forwarded(Exception):
            pass
        for args in (["acp", "--disable-telemetry"], ["--version"], ["-p", "user prompt"]):
            with self.subTest(args=args), \
                    mock.patch.object(adapter.sys, "argv", [str(SCRIPT), *args]), \
                    mock.patch.object(adapter, "resolve_binary", return_value="/official/agy"), \
                    mock.patch.object(adapter.os, "execv", side_effect=Forwarded) as execute, \
                    mock.patch.object(adapter, "interactive_usage") as usage:
                with self.assertRaises(Forwarded):
                    adapter.main()
                execute.assert_called_once_with("/official/agy", ["/official/agy", *args])
                usage.assert_not_called()

    def test_cleanup_terminates_a_real_owned_process_group(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            adapter.stop_group(child)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)

    def test_cleanup_kills_a_process_that_ignores_sigterm(self):
        child = subprocess.Popen([
            sys.executable, "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready',flush=True); time.sleep(60)",
        ], stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            started = time.monotonic()
            adapter.stop_group(child)
            self.assertIsNotNone(child.poll())
            self.assertLess(time.monotonic() - started, 3)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            child.stdout.close()

    def test_cleanup_reaches_descendants_after_the_leader_exits(self):
        code = "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; print(\"ready\",flush=True); time.sleep(60)'])"
        leader = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                  text=True, start_new_session=True)
        selector = selectors.DefaultSelector()
        try:
            self.assertEqual(leader.stdout.readline().strip(), "ready")
            leader.wait(timeout=3)
            adapter.stop_group(leader)
            selector.register(leader.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=1), "descendant still owns the output pipe")
            self.assertEqual(leader.stdout.read(), "")
        finally:
            try:
                os.killpg(leader.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            leader.wait(timeout=3)
            selector.close()
            leader.stdout.close()

    def test_cleanup_retries_transient_macos_eperm_and_stops_after_esrch(self):
        child = mock.Mock(pid=12345)
        with mock.patch.object(adapter.os, "killpg", side_effect=[
            None, PermissionError(errno.EPERM, "reaping"), ProcessLookupError(errno.ESRCH, "gone"),
        ]) as killpg:
            adapter.stop_group(child)
        self.assertEqual([call.args[1] for call in killpg.call_args_list], [signal.SIGTERM, 0, 0])

    def test_cleanup_can_confirm_esrch_when_macos_denies_the_zero_signal_probe(self):
        child = mock.Mock(pid=12345)
        with mock.patch.object(adapter.os, "killpg", side_effect=[
            None, *[PermissionError(errno.EPERM, "probe") for _ in range(3)],
            ProcessLookupError(errno.ESRCH, "gone"),
        ]) as killpg:
            adapter.stop_group(child)
        self.assertEqual([call.args[1] for call in killpg.call_args_list], [signal.SIGTERM, 0, 0, 0, signal.SIGKILL])

    def test_cleanup_reports_persistent_signal_denial(self):
        child = mock.Mock(pid=12345)
        with mock.patch.object(adapter.os, "killpg", side_effect=PermissionError(errno.EPERM, "denied")):
            with self.assertRaisesRegex(RuntimeError, "cleanup: signaling was denied"):
                adapter.stop_group(child)


if __name__ == "__main__":
    unittest.main()
