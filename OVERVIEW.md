# Better Paseo Antigravity

A stability and reliability enhancement over Paseo's built-in Antigravity ACP provider. Better Paseo Antigravity wraps the same official, locally signed-in `agy acp` CLI through Paseo's official ACP SDK, focusing on fixing transport, lifecycle, cancellation, and state-tracking bugs that occur in long coding sessions—without feature bloat, modifying your CLI login, touching private session databases, or diverging from the official protocol.

## Comparison with the built-in Antigravity ACP provider

Both providers run the official `agy acp` CLI on top of Paseo's ACP SDK and share the same model selection, thinking options, slash commands, skills, tool approvals, and session resume workflow. Better Paseo Antigravity hardens the layer between Paseo and `agy acp` so long-running sessions stay stable and recover cleanly where the built-in ACP provider can stall, drop errors, or leak processes.

| Built-in Antigravity ACP provider issue | Better Paseo Antigravity enhancement |
| --- | --- |
| Long-running tools or approvals killed for silence | Waits silently without no-progress notices or termination based only on silence. Completed tool calls can leave background work running; use Stop if a session appears stuck. |
| Hung stop/cancel requests and orphaned processes | Bounds explicit Stop delivery independently of a blocked write queue, targets only the in-flight requests, foreground tools, and approvals active at cancel time (including restored approvals without an active turn) with a 5-second fallback deadline, and runs a time-bounded graceful ACP close followed by detached POSIX process-group cleanup. Later requests never inherit an old cancel deadline. |
| Swallowed root-cause errors on disconnect | Captures the underlying transport, watchdog, exit-code, or signal diagnostics before closing the stream so generic SDK errors do not hide the real cause. |
| Truncated or stalled large history replays | Follows the native `session/load` boundary in `agy >= 1.5.15`, preserving wire order, fragmented UTF-8 decoding, and backpressure without waiting for stream silence. Live updates appear immediately after restore without requiring a new prompt. |
| False timeouts after laptop sleep/wake | Detects host suspend and clock jumps (>5s timer gap), rebasing pre-sleep work (including work started in the final timer slice before suspend) while keeping fresh post-wake deadlines intact. |
| Background tools cleared when a turn finishes | Retires tool state only on explicit tool-terminal events so background tools preserved for follow-up turns keep running. |
| Unverified CLI readiness or vague status errors | Provider status checks verify the `agy` CLI version (`>=1.5.15`) and perform an ACP handshake within a shared ~95-second cold-start budget, reporting recognized sign-in failures without printing authorization URLs. |

## How it works

Select Better Paseo Antigravity when creating a new agent. Existing sessions created with the built-in Antigravity provider are not migrated. Models, thinking options, slash commands, skills, tool approvals, and session resume continue to use the Paseo ACP SDK. Full access mode is opt-in and disabled by default. Prompts are never resent automatically after a stall, disconnect, or cancellation.

## Setup and requirements

- **OS**: macOS or Linux (Windows is unsupported due to POSIX process-group signaling).
- **Paseo**: `>=0.17.3 <0.18.0`.
- **Antigravity CLI**: Official `agy` `>=1.5.15` installed and signed in on the daemon host (`1.5.16` recommended for its upstream subagent approval/question forwarding fix).

Provider status checks verify the `agy` CLI version and perform an ACP handshake within a shared ~95-second cold-start budget. Recognized sign-in failures are reported without printing authorization URLs. Account eligibility and model access are still verified when opening a session.

Full access is an SDK auto-approval mode backed by native default, not native Auto. Ambiguous allow options (including repeated allow_always kinds) fall back to manual approval. The current SDK does not forward permission response message/updatedInput fields; free-text subagent answers are unsupported. Concurrent pending approvals with the same toolCallId in one native session may collide. Steering is available only in SDK-deferred turns, not necessarily while a native background prompt remains open. Command names without classification metadata remain unclassified rather than being assumed to be skills.

Host/UI dismissal after a restored-approval Stop timeout remains unverified.

Plan-quota queries have been removed to comply with Google Antigravity's ToS restrictions: external clients must use the official ACP protocol. The plugin retains only the ACP provider and does not wrap or poll `agy -p /usage`. Quota reporting will only be reconsidered if official ACP exposes a supported quota capability.

## Privacy and boundaries

Prompts and tool outputs go to Google's Antigravity backend through the local official `agy` CLI using your existing sign-in. The plugin does not create a separate OAuth flow, account directory, or network proxy. It does not copy or store credentials, and it does not overwrite `GEMINI_HOME`, `SSH_*`, or `BROWSER`. It does not read private native session SQLite databases or transcripts. Progress notices inserted by older versions remain in timeline history. Account eligibility, rate limits, and network failures cannot be bypassed by the plugin.
