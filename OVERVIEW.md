# Better Paseo Antigravity

A stability and reliability enhancement over Paseo's built-in Antigravity ACP provider. Better Paseo Antigravity wraps the same official, locally signed-in `agy acp` CLI through Paseo's official ACP SDK, focusing on fixing transport, lifecycle, cancellation, and state-tracking bugs that occur in long coding sessions—without feature bloat, modifying your CLI login, touching private session databases, or diverging from the official protocol.

## Comparison with the built-in Antigravity ACP provider

Both providers run the official `agy acp` CLI on top of Paseo's ACP SDK and share the same model selection, thinking options, slash commands, skills, tool approvals, and session resume workflow. Better Paseo Antigravity hardens the layer between Paseo and `agy acp` so long-running sessions stay stable and recover cleanly where the built-in ACP provider can stall, drop errors, or leak processes.

| Built-in Antigravity ACP provider issue | Better Paseo Antigravity enhancement |
| --- | --- |
| Upstream SSE silence while TCP remains connected | Optional SSE stall auto-recovery (off by default to protect long thinking such as Extra High mode). Enable it in Settings → Plugins → Better Paseo Antigravity with configurable silence timeout (`10–3600s`, default `300s`) and maximum retries (`0–10`, default `3`) using exponential backoff (`2s -> 4s -> 8s`) when substantive progress occurs. Zero-progress stalls circuit-break immediately; foreground tools, approvals, replay and observed unfinished background jobs block recovery. |
| Hung stop/cancel requests and orphaned processes | Bounds explicit Stop delivery independently of a blocked write queue, targets only the in-flight requests, foreground tools, and approvals active at cancel time (including restored approvals without an active turn) with a 5-second fallback deadline, and runs a time-bounded graceful ACP close followed by detached POSIX process-group cleanup. Later requests never inherit an old cancel deadline. |
| Swallowed root-cause errors on disconnect | Captures the underlying transport, watchdog, exit-code, or signal diagnostics before closing the stream so generic SDK errors do not hide the real cause. |
| Truncated or stalled large history replays | Follows the native `session/load` boundary in `agy >= 1.5.15`, preserving wire order, fragmented UTF-8 decoding, and backpressure without waiting for stream silence. Live updates appear immediately after restore without requiring a new prompt. |
| False timeouts after laptop sleep/wake | Detects host suspend and clock jumps (>5s timer gap), rebasing pre-sleep work (including work started in the final timer slice before suspend) while keeping fresh post-wake deadlines intact. |
| Background tools cleared when a turn finishes | Foreground tool-row tracking still retires only on explicit tool-terminal events. Separate recovery guards distinguish ordinary turn-scoped async work from live persistent daemon/cron jobs. |
| Unverified CLI readiness or vague status errors | Provider status checks verify the `agy` CLI version (`>=1.5.15`) and perform an ACP handshake within a shared ~95-second cold-start budget, reporting recognized sign-in failures without printing authorization URLs. |

## How it works

Select Better Paseo Antigravity when creating a new agent. Existing sessions created with the built-in Antigravity provider are not migrated. Models, thinking options, slash commands, skills, tool approvals, and session resume continue to use the Paseo ACP SDK. Full access mode is opt-in and disabled by default. The original user prompt is never automatically replayed. Only a guarded stall cancellation may start a separate, visible continuation prompt (at most one per stall, up to 3 per user round with zero-progress circuit breaking); disconnects, user Stop and errors do not trigger retries.

### Why SSE recovery is needed

Field investigations using `acp-server-*.log`, `daemon.log` and Mihomo's live connection table found that Google's `daily-cloudcode-pa.googleapis.com` `streamGenerateContent?alt=sse` can stop sending SSE after partial reasoning without `END_STREAM`, while TCP remains `ESTABLISHED`. The closed-source `agy` client lacks an SSE inter-chunk idle-read timeout, so `session/prompt` hangs and Paseo remains `running`. This upstream combination—not a defect originating in this plugin—motivates the optional outer safety net (disabled by default; default 300-second threshold and 3 retries when enabled in plugin settings). The plugin never calls that endpoint directly.

### Plugin settings: SSE stall auto-recovery

Open Settings → Plugins → Better Paseo Antigravity to configure optional upstream SSE stall auto-recovery. Settings are stored per daemon host (`stall-recovery`) and apply immediately to active and new sessions without reloading the plugin.

| Setting | Default | Range | Behavior |
| --- | --- | --- | --- |
| Enable SSE stall auto-recovery | Off (`false`) | On / Off | Disabled by default so long silent thinking turns (such as High or Extra High mode) are never prematurely canceled. Toggling saves immediately. |
| Silence detection timeout (seconds) | `300` | `10–3600` | Shown when recovery is enabled. Counts only eligible silence with no foreground tools, pending approvals, replay, or observed unfinished background jobs. Increase further (for example `450–600`) if Extra High thinking turns stay quiet longer. |
| Maximum continuation retries | `3` | `0–10` | Shown when recovery is enabled. Maximum deduplicated continuations per user round when substantive progress is made, using exponential backoff (`2s -> 4s -> 8s`). Zero-progress stalls circuit-break immediately. Set to `0` to auto-cancel without sending a continuation prompt. |

Live-update semantics:

- Enabling recovery mid-turn starts a fresh silence window from the moment it is turned on, rather than counting prior silence retroactively.
- Turning recovery off immediately clears the silence clock and irreversibly invalidates any in-flight cancel or pending backoff continuation; re-enabling cannot resurrect an older continuation plan.
- Lowering the silence timeout keeps the currently accumulated silence window and triggers on the next poll if elapsed silence already meets the new threshold.
- Parameter changes are edited as a draft with explicit Save changes and Reset defaults (`300s / 3`) actions and revision-conflict protection across clients. If the stored settings file is ever invalid, it is preserved without silent overwrite and can be recovered via Reset to defaults.

### Three recovery gates

1. Count silence only with one unresolved prompt, no foreground tools, no approvals, no replay and no user Stop. Live thought/text output restarts the window; sleep/clock jumps rebase it. `run_command` background-task output / `IsDaemon`, `invoke_subagent` and `schedule` create separate background guards, even when the launcher reports completion. SDK-deferred/steered turns are excluded.
2. Use public `session.interrupt` → ACP `session/cancel`, retaining the 5-second cancel fallback. Wait for both delivery and the SDK canceled turn with native `cancelled` response, then apply exponential backoff (`2s -> 4s -> 8s`) before sending a new public `session.prompt` (up to 3 continuations per user round when substantive progress is observed). It directs the model to continue from existing tool outputs and disk state without repeating successful writes, commands or external actions. A stall with zero substantive progress after a continuation circuit-breaks immediately; exhausting 3/3 stops cleanly. User Stop, a new message or transport failure invalidates pending continuation immediately.
3. A successful recovery emits three concise `session.notice` cards: cancellation requested, continuation started, and a lightweight resumed-work confirmation once the model produces its first resumed thought, text or tool activity. Normal completion is logged without an extra notice; abandoned recovery, zero-progress stops and exhausted retries retain abnormal-state notices. Structured diagnostics contain metadata only, never reasoning, tool payloads, credentials or raw stderr.

Internal continuation `session.prompt_result` receipts are consumed after replacement cleanup and turn binding; the SDK's visible timeline and `session.turn` events remain intact. Host-originated receipts are still forwarded.

A completed launcher is not a completed background job. Ordinary non-daemon background commands, `invoke_subagent` and one-shot schedules protect their current turn; after native `end_turn` and normal SDK completion without cancellation/replacement, the next user turn clears those scopes. Live `IsDaemon === true` or nonempty cron schedules keep transport-scoped protection until an explicit same-call numeric exit/terminal update or transport closure. History replay never creates these guards, so old jobs cannot permanently disable fresh-turn recovery. Abnormal endings do not clear pending turn scopes. Field evidence from `agy 1.5.18` shows ordinary background commands can complete by independent system callback without a same-call numeric exit update. Unreported background work and completely silent long thinking cannot be reliably distinguished from stalls. Anti-duplication instructions are not an exactly-once guarantee. The roughly 120-second quiet diagnostic remains separate and diagnostic-only. Real host/UI validation of the recovery flow remains pending.

## Setup and requirements

- **OS**: macOS or Linux (Windows is unsupported due to POSIX process-group signaling).
- **Paseo**: `>=0.17.3`.
- **Antigravity CLI**: Official `agy` `>=1.5.15` installed and signed in on the daemon host (`1.5.16` recommended for its upstream subagent approval/question forwarding fix).
- **Plugin settings (optional)**: Stored per daemon host under Settings → Plugins → Better Paseo Antigravity (`stall-recovery`). SSE stall auto-recovery defaults to off (`enabled: false`); when turned on, you can configure silence detection timeout (`10–3600s`, default `300s`) and maximum continuation retries (`0–10`, default `3`, where `0` cancels without continuing). Changes apply live without reloading the plugin.

Provider status checks verify the `agy` CLI version and perform an ACP handshake within a shared ~95-second cold-start budget. Recognized sign-in failures are reported without printing authorization URLs. Account eligibility and model access are still verified when opening a session.

Full access is an SDK auto-approval mode backed by native default, not native Auto. Ambiguous allow options (including repeated allow_always kinds) fall back to manual approval. The current SDK does not forward permission response message/updatedInput fields; free-text subagent answers are unsupported. Concurrent pending approvals with the same toolCallId in one native session may collide. Steering is available only in SDK-deferred turns, not necessarily while a native background prompt remains open. Command names without classification metadata remain unclassified rather than being assumed to be skills.

Host/UI dismissal after a restored-approval Stop timeout remains unverified.

Plan-quota queries have been removed to comply with Google Antigravity's ToS restrictions: external clients must use the official ACP protocol. The plugin retains only the ACP provider and does not wrap or poll `agy -p /usage`. Quota reporting will only be reconsidered if official ACP exposes a supported quota capability.

## Privacy and boundaries

Prompts and tool outputs go to Google's Antigravity backend through the local official `agy` CLI using your existing sign-in. The plugin does not create a separate OAuth flow, account directory, or network proxy. It does not copy or store credentials, and it does not overwrite `GEMINI_HOME`, `SSH_*`, or `BROWSER`. It does not read private native session SQLite databases or transcripts. Progress notices inserted by older versions remain in timeline history. Account eligibility, rate limits, and network failures cannot be bypassed by the plugin.
