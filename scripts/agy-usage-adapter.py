#!/usr/bin/env python3
"""Opt-in POSIX adapter for agy 1.5.17's interactive /usage command.

See docs/usage-eligibility.md. Only the exact headless usage invocation is
adapted. ACP, --version and all other arguments exec the official binary.
"""
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time

TIMEOUT_SECONDS = 14
OUTPUT_LIMIT = 1024 * 1024


def plain_text(raw):
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    return re.sub(r"\x1b[@-_]", "", text).replace("\r", "")


def parse_quota(text, now=None):
    """Accept a complete known quota panel; return no account identifiers."""
    marker = text.rfind("Models & Quota")
    if marker < 0:
        return None
    panel = text[marker:]
    headings = list(re.finditer(r"(?m)^([A-Z][A-Z &+/-]*MODELS)\s*$", panel))
    now = now or datetime.datetime.now(datetime.timezone.utc)
    groups = []
    for index, heading in enumerate(headings):
        name = heading.group(1)
        end = headings[index + 1].start() if index + 1 < len(headings) else len(panel)
        body = panel[heading.end():end]
        labels = list(re.finditer(r"(Weekly|Five Hour) Limit Remaining", body))
        if len(labels) != 2:
            return None
        buckets = []
        for bucket_index, label in enumerate(labels):
            end = labels[bucket_index + 1].start() if bucket_index + 1 < len(labels) else len(body)
            content = body[label.end():end]
            percent = re.search(r"(?<![\d.-])(\d+(?:\.\d+)?)%", content)
            reset = re.search(r"Refreshes in ((?:\d+\s*[dhm]\s*)+)", content)
            if not percent or (not reset and "Quota available" not in content):
                return None
            remaining = float(percent.group(1)) / 100
            if not 0 <= remaining <= 1:
                return None
            reset_time = None
            if reset:
                seconds = sum(
                    int(amount) * {"d": 86400, "h": 3600, "m": 60}[unit]
                    for amount, unit in re.findall(r"(\d+)\s*([dhm])", reset.group(1))
                )
                try:
                    reset_time = (now + datetime.timedelta(seconds=seconds)).isoformat()
                except OverflowError:
                    return None
            window = "weekly" if label.group(1) == "Weekly" else "5h"
            group_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            buckets.append({
                "id": group_id + "-" + window,
                "name": label.group(0), "window": window,
                "remaining_fraction": remaining, "reset_time": reset_time,
            })
        if {bucket["window"] for bucket in buckets} != {"weekly", "5h"}:
            return None
        groups.append({"name": name.title(), "buckets": buckets})
    expected = {"GEMINI MODELS", "CLAUDE AND GPT MODELS"}
    if len(groups) != 2 or {group["name"].upper() for group in groups} != expected:
        return None
    return {"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": groups}}}


def resolve_binary():
    binary = shutil.which(os.environ.get("AGY_USAGE_BINARY", "agy"))
    if not binary:
        raise RuntimeError("Official agy was not found; set AGY_USAGE_BINARY to its executable path.")
    if Path(binary).resolve() == Path(__file__).resolve():
        raise RuntimeError("AGY_USAGE_BINARY must name the official CLI, not this adapter.")
    return binary


def trusted_directory():
    directory = Path(os.environ.get("AGY_USAGE_CWD", os.getcwd())).expanduser().resolve()
    try:
        settings = Path.home() / ".gemini/antigravity-cli/settings.json"
        trusted = json.loads(settings.read_text()).get("trustedWorkspaces", [])
    except (OSError, ValueError, AttributeError):
        trusted = []
    if not isinstance(trusted, list):
        trusted = []
    candidates = [Path(value).expanduser().resolve() for value in trusted if isinstance(value, str)]
    if directory.is_dir() and any(root == directory or root in directory.parents for root in candidates):
        return str(directory)
    raise RuntimeError("Set AGY_USAGE_CWD to a workspace already trusted in the official agy CLI.")


def stop_group(child):
    def attempt(signum):
        for retry in range(3):
            try:
                os.killpg(child.pid, signum)
                return "ok"
            except ProcessLookupError:
                return "gone"
            except PermissionError:
                # macOS can briefly report EPERM while an exited group leader
                # is being reaped. Match the plugin's bounded signal retries.
                child.poll()
                if retry == 2:
                    return "denied"
                time.sleep(0.025)

    if attempt(signal.SIGTERM) == "gone":
        child.wait(timeout=1)
        return
    # The leader can already have exited while a descendant still owns the
    # terminal. Reap the leader, but bound cleanup for the entire owned group.
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        child.poll()
        state = attempt(0)
        if state == "gone":
            return
        if state == "denied":
            break
        time.sleep(0.05)
    if attempt(signal.SIGKILL) == "denied":
        raise RuntimeError("Unable to confirm agy process-group cleanup: signaling was denied.")
    child.wait(timeout=1)


def interactive_usage():
    binary, directory = resolve_binary(), trusted_directory()
    master, slave = pty.openpty()
    child = None
    selector = selectors.DefaultSelector()
    raw = bytearray()
    sent = False
    terminal_closed = False
    last_output = started = time.monotonic()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 180, 0, 0))
        child = subprocess.Popen(
            [binary, "--settings", '{"altScreenMode":"never","colorScheme":"dark"}'],
            stdin=slave, stdout=slave, stderr=slave, cwd=directory,
            env=dict(os.environ, TERM="xterm-256color", NO_COLOR="1"),
            start_new_session=True,
        )
        os.close(slave)
        slave = None
        selector.register(master, selectors.EVENT_READ)
        while time.monotonic() - started < TIMEOUT_SECONDS:
            for key, _ in selector.select(0.15):
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    terminal_closed = True
                    break
                raw.extend(chunk)
                last_output = time.monotonic()
                if len(raw) > OUTPUT_LIMIT:
                    raise RuntimeError("agy usage terminal output exceeded the size limit.")
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
            text = plain_text(raw)
            if sent and (terminal_closed or time.monotonic() - last_output >= 0.25):
                report = parse_quota(text)
                if report is not None:
                    return report
            if terminal_closed or child.poll() is not None:
                break
            if any(prompt in text for prompt in (
                "Choose your color scheme:", "Terms of Service & Data Use",
                "Do you trust the contents of this project?",
                "Open the following link to authenticate",
            )):
                raise RuntimeError("Complete agy setup and sign-in in a terminal before querying usage.")
            if not sent and "for shortcuts" in text and time.monotonic() - last_output >= 0.7:
                os.write(master, b"/usage\r")
                sent = True
        raise RuntimeError("agy interactive /usage did not return a complete quota panel within 14 seconds.")
    finally:
        if slave is not None:
            os.close(slave)
        try:
            if child is not None:
                stop_group(child)
        finally:
            selector.close()
            os.close(master)


def interrupted(_signum, _frame):
    raise RuntimeError("agy interactive usage query was interrupted.")


def main():
    args = sys.argv[1:]
    if args != ["-p", "/usage", "--output-format", "json"]:
        try:
            binary = resolve_binary()
            os.execv(binary, [binary, *args])
        except (RuntimeError, OSError):
            print("Unable to execute the official agy CLI. Check AGY_USAGE_BINARY.", file=sys.stderr)
            return 1
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(interactive_usage()))
    except (RuntimeError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "Unable to run the agy usage terminal."
        print(json.dumps({"status": "ERROR", "error": message}))
    # The JSON status carries a query failure. A nonzero exit makes older
    # plugin versions discard the structured diagnostic.
    return 0


if __name__ == "__main__":
    sys.exit(main())
