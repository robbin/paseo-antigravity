# Better Paseo Antigravity

Built for long-session reliability, not feature bloat. Better Paseo Antigravity wraps the official, locally signed-in `agy acp` CLI through Paseo's ACP SDK to keep multi-hour agent runs stable without modifying your CLI login, touching private session databases, or reinventing the protocol.

## Reliability first

| Common failure mode | How Better Paseo Antigravity handles it |
| --- | --- |
| Long-running tools or approvals killed for silence | Waits silently without no-progress notices or termination based only on silence. Completed tool calls can leave background work running; use Stop if a session appears stuck. |
| Hung stop/cancel requests and orphaned processes | Targets only the in-flight requests, foreground tools and approvals active at cancel time (including restored approvals without an active turn), each with a 5-second fallback deadline. Shutdown runs a time-bounded graceful ACP close followed by detached POSIX process-group cleanup. Later requests never inherit an old cancel deadline. |
| Swallowed root-cause errors on disconnect | Captures the underlying transport, watchdog, exit-code, or signal diagnostics before closing the stream so generic SDK errors do not hide the real cause. |
| Truncated or stalled large history replays | Follows the native `session/load` boundary in `agy >= 1.5.15`, preserving wire order, fragmented UTF-8 decoding, and backpressure without waiting for stream silence. Live updates appear immediately after restore without requiring a new prompt. |
| False timeouts after laptop sleep/wake | Detects host suspend and clock jumps (>5s timer gap), rebasing pre-sleep work (including work started in the final timer slice before suspend) while keeping fresh post-wake deadlines intact. |
| Background tools cleared when a turn finishes | Retires tool state only on explicit tool-terminal events so background tools preserved for follow-up turns keep running. |

## How it works

Select Better Paseo Antigravity when creating a new agent. Existing sessions created with the built-in Antigravity provider are not migrated. Models, thinking options, slash commands, skills, tool approvals, and session resume continue to use the Paseo ACP SDK. Full access mode is opt-in and disabled by default. Prompts are never resent automatically after a stall, disconnect, or cancellation.

## Setup and requirements

- **OS**: macOS or Linux (Windows is unsupported due to POSIX process-group signaling).
- **Paseo**: `>=0.17.3 <0.18.0`.
- **Antigravity CLI**: Official `agy` `>=1.5.15` installed and signed in on the daemon host (`1.5.16` recommended for its upstream subagent approval/question forwarding fix).

Provider status checks verify the `agy` CLI version and perform an ACP handshake within a shared ~95-second cold-start budget. Recognized sign-in failures are reported without printing authorization URLs. Account eligibility and model access are still verified when opening a session. Usage quotas are queried through `agy -p /usage --output-format json` using your existing CLI login and environment.

Full access is an SDK auto-approval mode backed by native default, not native Auto. Ambiguous allow options (including repeated allow_always kinds) fall back to manual approval. The current SDK does not forward permission response message/updatedInput fields; free-text subagent answers are unsupported. Concurrent pending approvals with the same toolCallId in one native session may collide. Steering is available only in SDK-deferred turns, not necessarily while a native background prompt remains open. Command names without classification metadata remain unclassified rather than being assumed to be skills.

Usage queries include session environment overrides. Custom ACP `--app-data-dir` / `--gemini-dir` / `--cli_dir_name` (including underscore aliases) configurations currently report an unsupported-query error instead of querying the default account. API Key no-quota classification and host/UI dismissal after a restored-approval Stop timeout remain unverified.

## Privacy and boundaries

Prompts, tool outputs, and usage queries go to Google's Antigravity backend through the local official `agy` CLI using your existing sign-in. The plugin does not create a separate OAuth flow, account directory, or network proxy. It does not copy or store credentials, and it does not overwrite `GEMINI_HOME`, `SSH_*`, or `BROWSER`. It does not read private native session SQLite databases or transcripts. Progress notices inserted by older versions remain in timeline history. Account eligibility, rate limits, and network failures cannot be bypassed by the plugin.
