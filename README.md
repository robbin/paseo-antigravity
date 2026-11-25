# Better Paseo Antigravity

A stability-first [Paseo](https://paseo.sh) plugin providing a hardened ACP provider and official usage quota source (`better-paseo-antigravity`) for Google's official Antigravity CLI (`agy acp`).

## Built for Long-Session Reliability

When running real coding agents for extended sessions, extra UI gimmicks matter far less than whether a session stays alive, stops cleanly when asked, and recovers cleanly from sleep or reconnects.

Paseo's built-in Antigravity provider can run into reliability issues during real-world sessions—such as premature stalls, hung cancellation requests, orphaned child processes, truncated large history replays, and swallowed error messages. Better Paseo Antigravity wraps the official `agy acp` binary on top of Paseo's official ACP SDK to fix these transport, lifecycle, and state-tracking issues without altering your CLI login, reading private session databases, or diverging from the official protocol.

### Stability at a Glance

| Failure mode | How Better Paseo Antigravity handles it |
| --- | --- |
| Silent stalls vs. long-running work | Waits silently without no-progress notices or silence-only termination. Completed tools can leave native background work running; use Stop when a session appears stuck. |
| Hung stop/cancel & orphaned processes | Bounds explicit Stop delivery independently of the write queue, retains a 5-second fallback deadline per canceled target, followed by time-bounded graceful ACP close and detached POSIX process-group cleanup (`SIGTERM` → 1s grace → `SIGKILL`). |
| Cancel races & stale tool tracking | Ignores idle cancels, isolates `session/load` replay from live tracking, scopes cancel deadlines per target, and retires tools only on explicit tool-terminal events. |
| Swallowed root-cause errors | Records transport, watchdog, exit-code, and signal failure details before closing the stream so generic SDK errors never hide the real cause. |
| Broken large history replay | Uses `agy >= 1.5.15`'s protocol-ordered `session/load` boundary with fragmented UTF-8 decoding and backpressure safety; live updates appear immediately after restore. |
| Laptop sleep/wake false timeouts | Detects suspend and clock jumps (>5s timer gap), rebasing pre-sleep operations while preserving fresh post-wake deadlines. |

### Engineering Details

- **Quiet waiting without premature kills**
  - Waits silently during idle periods and quiet active turns, without inserting no-progress notices.
  - Does not infer deadlock from silence or completed tool calls; native background work may still be running.
  - Retains startup/control-request deadlines, explicit Stop fallback and transport-error cleanup. A silent deadlock requires manual Stop; prompts are never resent automatically.
- **Reliable cancellation and process-group cleanup**
  - Enforces a 5-second fallback deadline for canceled prompts, foreground tools and approvals, including restored approvals without an active turn.
  - Performs a time-bounded graceful ACP close (5-second grace) followed by detached POSIX process-group cleanup (`SIGTERM` with 1-second grace, then `SIGKILL`).
  - Handles `ESRCH` and `EPERM` races safely so exited leaders never cause infinite waits or stray signals.
- **Cancel race and stale tool-call protection**
  - Ignores idle cancel requests so they cannot poison or kill a subsequent turn.
  - Keeps `session/load` history replay out of live tool-call tracking.
  - Tracks cancellation targets individually: completing an old canceled request releases its deadline without affecting later requests; repeated cancellation does not postpone an existing target's deadline.
  - Retires tools only on explicit ACP or SDK tool-terminal events. A foreground turn completing does not clear background tools preserved by the SDK for a follow-up turn.
- **Preserved root-cause error messages**
  - Records the underlying transport or watchdog failure reason before closing the stream, including an unexpected exit code or signal when available.
  - Replaces generic SDK errors (`ACP transport closed unexpectedly`, `Connection closed`, `ACP turn failed`) with the actual cause without overwriting meaningful upstream errors.
- **Protocol-ordered history replay and live restoration**
  - Requires `agy >=1.5.15`, which finishes history before the `session/load` response. Preserves that wire order without waiting for a silent output stream.
  - Keeps fragmented UTF-8 decoding and backpressure handling. After restoration, live messages and tool updates are no longer suppressed until the next user prompt.
- **Host sleep and wake resilience**
  - Detects system suspend or clock jumps (>5-second timer gap), including operations started in the final timer slice before suspension. Old or future-dated timestamps are rebased while fresh post-wake operations retain their deadlines.
- **EOF, EPIPE, and backpressure safety**
  - Flushes `StringDecoder` and parses trailing newline-free frames on EOF.
  - Avoids discarding queued replies on `EPIPE` and respects consumer backpressure without manufacturing premature EOF.
- **Full official CLI compatibility and quota reporting**
  - Reuses your existing `agy` login, config, and environment (`GEMINI_HOME`, `SSH_*`, and `BROWSER` are never overwritten).
  - Keeps per-model thinking options, slash commands, skills, native/MCP tool-call mappings, and opt-in `Full access` mode.
  - Restores real CLI version + ACP handshake diagnostics in provider status checks and quota reporting via `agy -p /usage --output-format json`.
  - Status probes share a ~95-second cold-start budget across version checking and handshake, and preserve recognized sign-in diagnostics without exposing authorization URLs.

## Diagnosing a quiet session

Long thinking is not evidence of a deadlock. After roughly two minutes without live inbound activity or a completed local write, an active turn emits at most one `[antigravity:quiet]` log. It does not add a timeline notice, stop the task, or resend anything. Inspect plugin logs in Paseo Settings → Plugins → Logs.

The snapshot reports observed state, not a diagnosis of the model service:

- `pendingWrite` / `pendingWriteAgeMs`: a local write has not completed. Even a completed write does not prove that the CLI read or processed it.
- `openPrompts > 0`: native prompt responses are still outstanding; thinking, tools, approvals or the upstream service may be involved.
- `openPrompts === 0` while the turn remains active: the native prompt has returned, but the SDK may still be waiting for tools or other completion signals. A subsequent steer can increase this count again.
- An existing empty/tool-only end notice means the turn ended without the expected final text, rather than necessarily still running.

`[antigravity:stop]` logs track explicit Stop requests separately. Stop now has a local request-delivery fallback (5 seconds by default, plus timer scheduling), independent of the blocked write queue. Once the cancel reaches the transport, the existing per-target cancellation deadline still applies. These phases can overlap or run in sequence, followed by process-group cleanup; this is not a promise that every Stop finishes within exactly 5 seconds. Rejected and idle Stop requests must not arm a new deadline. A prompt still queued inside the SDK, with no started turn or observed cancellable work, remains outside this new guarantee.

If a session appears stuck: note the time and last visible activity, press Stop, then reopen/restore the session if the connection was closed. Check what tools already executed before explicitly asking it to continue. Sending another message is not a reliable recovery operation: it can itself queue, replace a turn, or repeat work. No prompt is automatically retried. The new logs contain only allowlisted metadata, not prompt/reasoning/tool contents or raw stderr; this does not filter every error originating in the SDK.

The reproducible fix concerns input backpressure blocking cancellation. It does not establish the cause of any particular Gemini/model/thinking-level incident. A source commit or merge does not update the plugin already loaded in the daemon.

## Requirements

- **OS**: macOS or Linux (Windows is not currently supported due to POSIX process-group signaling)
- **Paseo**: `>=0.17.3 <0.18.0`
- **Antigravity CLI**: Official `agy` `>=1.5.15`, installed and signed in on the daemon host

## Installation

Make sure plugins are enabled on your Paseo daemon (**Settings → Plugins → Enable plugins**).

### Via Paseo App (Settings)

1. Open Paseo and go to **Settings → Plugins → Plugin source**.
2. Paste the repository URL or Git shorthand:
   - `https://github.com/robbin/paseo-antigravity`
   - or `git:robbin/paseo-antigravity`
3. Click **Install plugin**.

### Via Paseo CLI

```bash
paseo plugin install git:robbin/paseo-antigravity
```

To update later:

```bash
paseo plugin update better-paseo-antigravity
```

## Usage

1. Create a new agent in Paseo and select **Better Paseo Antigravity** as the provider.
2. Choose your model, thinking level, and permission mode (`Full access` is available as an opt-in mode and is not enabled by default).
3. Existing sessions created with Paseo's built-in Antigravity provider are not automatically migrated.

## Known Boundaries

- Earlier than `agy 1.5.15` is unsupported; provider status and each new connection check the minimum version. `1.5.16` is recommended for its upstream subagent approval/question forwarding fix, but is not required.
- Full access is an SDK auto-approval mode backed by native default, not native Auto. Ambiguous allow options (including repeated allow_always kinds) fall back to manual approval. The current SDK does not forward permission response message/updatedInput fields; free-text subagent answers are unsupported. Concurrent pending approvals with the same toolCallId in one native session may collide. Steering is available only in SDK-deferred turns, not necessarily while a native background prompt remains open.
- Usage queries merge session environment overrides. Custom ACP `--app-data-dir` / `--gemini-dir` / `--cli_dir_name` (including underscore aliases) configurations currently report a safe query error rather than querying the default account. API Key no-quota classification is not yet verified; exit code 2 alone is not treated as evidence of no quota.
- On restored-approval Stop timeout, the SDK releases permission promises and emits runtime failure. Actual host/UI dismissal has not been validated.
- Commands remain executable; unknown command/skill names are left unclassified when ACP provides no provenance.
- Does not create a custom OAuth flow, proxy, or credential store; sign in using the official `agy` CLI on the host.
- Does not read private Antigravity SQLite databases, inboxes, or raw transcripts.
- Never automatically resends prompts after a stall, disconnect, or cancellation.
- Existing progress notices from older versions remain in timeline history; this version does not insert new no-progress notices.
- See [VALIDATION.md](./VALIDATION.md) for the test matrix and verification notes.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

To run the live integration test against your local signed-in `agy` CLI:

```bash
pnpm test:live --confirm-live
```

## License

Portions derived from Paseo's ACP provider and usage patterns remain under the Apache License 2.0 (see [LICENSE-Paseo](./LICENSE-Paseo)).
