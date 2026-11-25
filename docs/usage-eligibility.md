# Headless usage eligibility errors

On the observed agy 1.5.17 account, the official interactive `/usage` command
returns quota while `agy -p /usage --output-format json` exits during its
eligibility check. ACP model prompts also work. An eligibility failure on this
headless path therefore does not by itself establish that sign-in is missing,
the executable is outside PATH, or the quota endpoint is unusable.

## Reproduction and cause

Use an already signed-in official CLI on the daemon host:

```sh
agy --version
agy -p /usage --output-format json
```

The observed version was 1.5.17. The second command exited 1 after approximately
five seconds, returning this structured error (unrelated result fields omitted):

```json
{
  "status": "ERROR",
  "error": "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location."
}
```

The CLI logs confirmed successful silent authentication from the keyring before
the eligibility error. The same account's ACP model prompt returned a test
marker. No credential deletion or account switch was used.

Then start the interactive CLI, wait for its prompt, and enter `/usage`:

```text
$ agy
> /usage
```

This path can show the eligibility warning and still display **Models & Quota**.
In the observed run it returned both Gemini and Claude/GPT weekly and five-hour
quota buckets. These are observed differences between the CLI modes; this report
does not claim to identify the upstream implementation defect or change the
account's eligibility. Accounts with genuinely rejected quota access may still
fail on both paths.

The plugin's previous `execCommand` catch treated every nonzero exit as a
login/timeout failure, discarding the official JSON in `error.stdout`. The normal
usage source now recognizes safe error categories without displaying raw CLI
output. It does not automatically start an interactive terminal.

## Optional adapter

`scripts/agy-usage-adapter.py` is an explicit compatibility option for the case
where interactive `/usage` has been verified to work. It creates a background
POSIX PTY, runs the official CLI, sends `/usage` once, converts the complete
known quota panel into the existing JSON contract, and closes the process group.
It opens no IDE window. ACP, version checks and all other invocations exec the
official CLI with their original argument list.

Requirements and limits:

- Python 3 with POSIX `pty`, `fcntl` and process-group signaling. macOS is live
  tested; Linux remains unverified. The optional script does not add Python to
  the plugin's default installation requirements.
- Complete official CLI setup and sign-in yourself. The adapter stops on setup,
  authentication or trust prompts; it does not answer them.
- The current parser accepts the English 1.5.17 **Gemini Models** and **Claude
  And Gpt Models** panel with weekly and five-hour buckets. Partial, unknown or
  changed layouts fail closed. Disabled/differently grouped quotas are not yet
  supported by this optional parser.
- Percentages come from the terminal display, with its two-decimal precision.
  Refresh timestamps are estimates calculated from minute-resolution countdowns;
  `Quota available` has no reported reset time and maps to `null`.
- Output is capped at 1 MiB. The query has a 14-second budget and cleanup escalates
  from SIGTERM to SIGKILL with bounded waits, fitting inside the source's normal
  18-second command budget under the tested conditions. Slow cold starts can fail.
- The script reads CLI trust settings and inherits the existing environment. It
  does not read OAuth tokens, private session databases or old conversations, and
  does not print the terminal transcript or account email.
- The script's successful JSON delivery has exit code 0 even when the JSON
  `status` is `ERROR`; older plugin readers otherwise discard the diagnostic.

First locate the real CLI (`command -v agy`) and choose a workspace you have
already trusted in that CLI. Test the adapter directly, substituting your paths:

```sh
AGY_USAGE_BINARY=/absolute/path/to/official/agy \
AGY_USAGE_CWD=/absolute/path/to/trusted/workspace \
python3 /absolute/path/to/checkout/scripts/agy-usage-adapter.py \
  -p /usage --output-format json
```

If it returns `SUCCESS` with the expected groups, merge this provider override
into the existing `~/.paseo/config.json`; retain other configuration:

```json
{
  "agents": {
    "providers": {
      "better-paseo-antigravity": {
        "command": [
          "/absolute/path/to/python3",
          "/absolute/path/to/checkout/scripts/agy-usage-adapter.py",
          "acp",
          "--disable-telemetry"
        ],
        "env": {
          "AGY_USAGE_BINARY": "/absolute/path/to/official/agy",
          "AGY_USAGE_CWD": "/absolute/path/to/trusted/workspace"
        }
      }
    }
  }
}
```

Run `paseo reload --json` and confirm `agents.providers` was applied. Refresh the
global usage panel. Existing sessions may retain their old launch connection:
reload those sessions when idle. If a plugin reload is needed, first ensure all
of its agents are idle; plugin reload closes their connections, so reopen/reload
the original agents afterward to preserve their history and apply the command.
A source commit alone does not change a daemon's currently loaded connection.

To revert, remove only this command override and the two `AGY_USAGE_*` variables,
restore any previous command, and reload configuration. Keep the checkout in place
while it is configured. No plugin removal or account reset is required.

Custom ACP data-directory configurations remain rejected by the original usage
source, rather than silently querying a default account. This adapter has not
verified custom account/data directories.

## Evidence and delivery

Observed on 2026-11-25, macOS, Paseo Desktop/daemon 0.17.4, agy 1.5.17:

| Component | Version / setup |
| --- | --- |
| Operating system | macOS 26.5.1, build 25F80, arm64 |
| Paseo Desktop / daemon | 0.17.4 / 0.17.4, Desktop-managed local daemon, non-SSH CLI authentication |
| Official Antigravity CLI (`agy`) | **1.5.17** |
| Plugin installed during original reproduction / local prototype | Better Paseo Antigravity 0.3.1, commit `273438a35f62aaca815a0a100ee627e7ac6ceb43` |
| PR baseline | Plugin 0.3.4, upstream main `510340d304e4f5894fd793fbe79504944487b544` |
| Plugin SDK used for current-branch checks | `@getpaseo/plugin` 0.17.3 |
| Test runtimes | Node.js v22.22.1 (`process.version` from the test process), Python 3.13.2 |

| Scenario | Observed result |
| --- | --- |
| `agy -p /usage --output-format json` | Exit 1, eligibility/location error after successful authentication. |
| Interactive `agy`, then `/usage` | Real quota panel: Gemini remaining 89.53% weekly / 99.31% five-hour; Claude/GPT remaining 100% for both windows. |
| Local adapter prototype with plugin 0.3.1 | Global and session usage returned `available`; four windows, no login errors. A later global query took 8.47 seconds and returned 89.42% / 98.85% for Gemini and 100% / 100% for Claude/GPT. Values changed normally as the account was used. |
| ACP regression after the local configuration change and connection reload | The original test conversation returned `AGY_OK`; original agent IDs/history were retained. |
| Current PR source `Usage.fetch` with this PR's optional Python adapter | Live official agy 1.5.17 returned `available` with four windows in 8.726 seconds; Gemini 88.31% weekly / 97.42% five-hour, Claude/GPT 100% / 100%. This ran the 0.3.4 source directly and did not replace the installed plugin. |
| Final adapter after process-group cleanup hardening | Live current-branch `Usage.fetch` returned `available` in 6.594 seconds; Gemini 88.29% weekly / 97.32% five-hour, Claude/GPT 100% / 100%. The adapter also passed the provider's real CLI version check and ACP handshake. |

Current-branch checks: TypeScript typecheck passed; the complete TypeScript suite
passed 252/252; the Python suite passed 13/13; `git diff --check` passed. During
hardening, the first stronger cleanup check and a live query failed on macOS's
transient/persistent zero-signal `EPERM` probe during leader reaping. The final
adapter follows the repository's existing bounded retry/force-stop approach,
stops signaling after `ESRCH`, and includes tests for those states as well as
descendants remaining after their leader exits. The failed intermediate run is
not counted as a successful live check.

The prototype above is the prior local deployment evidence. The Python script in
this change removes personal paths, takes an explicit trusted directory, adds
cleanup/error guards and tests, and remains opt-in. Its current-branch validation
is reported separately in the pull request; the prototype run is not represented
as a live deployment of plugin 0.3.4.

Deliverables:

- `server/usage.ts`: safe diagnostics from structured errors and process status.
- `scripts/agy-usage-adapter.py`: optional adapter, without personal paths.
- `tests/usage-diagnostics.test.ts`: real subprocess/error-category regressions.
- `tests/test_usage_adapter.py`: anonymized panel, JSON protocol, argv forwarding
  and real process-group cleanup tests.
- This report: reproduction, evidence, setup, rollback and explicit limits.

Run checks from the repository root:

```sh
npm run typecheck
npm test
python3 -m unittest discover -s tests -p 'test_usage_adapter.py' -v
git diff --check
```

The tests use synthetic account/authorization sentinels and an anonymized panel.
No real token, account identifier, email, local agent ID, private log file or
personal absolute path is needed for this report.
