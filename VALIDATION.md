# Better Paseo Antigravity validation

## 0.3.4 release: bounded Stop delivery and safe diagnostics

- Maintenance release covering 07cf333 and e7e286a. Final suite: 246 tests, typecheck and diff check. Development dependencies and compatibility requirements are unchanged.
- Release scope: Git source, v0.3.4 tag and GitHub Release only. No npm publication, installed-plugin update/reload or daemon restart. Real model-incident root cause remains unverified.
- Feature scope is stable; further changes should follow reproducible defects rather than speculative recovery or added features.

### Accepted Stop intent and diagnostic correlation

- 氖元素's high-thinking review of 07cf333 reproduced an empty/tool-only notice after an admitted Stop whose cancel frame was still queued. Friday added an assertion to the real-SDK blocked-approval test and observed it fail before fixing the behavior.
- Provisional Stop tokens now retain their original Turn owner. Notice suppression and legacy metadata use the same effective cancellation intent. Admission rejection removes only that token from its captured owner; delivery settlement preserves the admitted intent without changing either cancellation deadline. The token set is excluded from legacy log metadata.
- Stop diagnostics distinguish `rejected` admission from `settled` delivery, and retain the original turn ID after turn completion/replacement. Logs remain explicit allowlists.
- Real-SDK regression cases cover empty and tool-only endings with accepted/rejected Stop, including SDK-visible completed tool events, notice presence/absence, cancellation metadata and timeout correlation. Unit tests cover multiple intents, precise rollback across turn changes, wire cancellation preservation, settlement/idempotence and log schema/privacy. No auto-retry, runtime deployment, dependency change or model-setting change is included.
- Verification: typecheck and all 246 tests pass. 氖元素's high-thinking read-only re-review confirmed the P2 fix and rejected-Stop log distinction, with no blockers or new regressions. He independently reran typecheck, all 246 tests, diff check, the three Stop-intent tests, and three repetitions of the four accepted/rejected ending cases. This validates source and local simulations, not a real model-incident root cause or deployment of the running plugin.

### Stop delivery fallback and quiet diagnostics

- Design reviewed independently by 氖元素 and 搬砖工, then finalized by Friday in `docs/acp-stall-recovery.md`. All implementation and tests authored by Friday; no coding delegated.
- Before the fix, a new real-provider/real-SDK fixture with a 4 MiB prompt and paused CLI stdin failed to produce a bounded Stop result; the resume-reading control passed. After the fix, both pass. The payload size is a reproduction parameter, not evidence about a historical user incident.
- Explicit Stop gets an independent provisional token, rolled back on admission rejection and released on SDK request completion/failure. Turn changes do not release pending Stop delivery. Existing wire cancellation target clocks remain separate. All in-flight host request IDs are reserved until their SDK terminal event (or admission rejection), preventing Stop acknowledgement collisions in either direction; completed IDs can be reused. Ordinary prompts do not arm this fallback.
- Owned close actively rejects an in-flight write before waiting for process-group reap. A fixture ignoring SIGTERM verifies prompt rejection precedes the grace period and the process is ultimately gone. Existing EOF/EPIPE/UTF-8/backpressure tests continue to pass.
- Added metadata-only Stop logs and one quiet snapshot per active turn, after roughly 120 seconds of no live inbound activity or completed local write. Snapshot fields are allowlisted; unknown method names become `other`. No timeline notice, no silence termination and no automatic prompt replay. Legacy prompt-end/turn-end schemas remain intact via explicit metadata construction.
- Added tests for repeated/idle Stop, token settlement, turn changes, two-stage deadlines, restored approvals, clock jumps, no-output/thinking/tool/compaction/text activity, replay/session isolation, same-turn steering counts, stale write callbacks, privacy/schema, SDK write pressure including deferred steering, rejected/duplicate Stop, and owned close. Initial implementation passed 236 tests. After review fixes the full suite is 240 passing tests; typecheck and diff check pass. All five current pressure/cleanup tests were additionally repeated five times successfully.
- 老法师's first review reproduced reverse request-ID collisions and old-tool/retired-echo contamination of the quiet clock. Friday added failing regressions before fixing both. New tests use a valid request ID with an SDK-rejected extra field to exercise actual provisional-token rollback, independently verify quiet rebasing without an earlier Stop timeout, check completed request-ID reuse and reopened-transport isolation, and reproduce a real SDK turn ending while Stop remains blocked behind a large approval response. The last case verifies the turn ends before the independent Stop timeout.
- Coverage is not a claim that every proposed scenario was independently reproduced: request completion strictly preceding the send-admission Promise continuation was not forced in an integration fixture. The token is installed before dispatch and no post-admission callback arms it; ordinary completion/late callbacks and ID reuse are tested.
- Limitations: a prompt queued inside SDK before any started turn/observed cancellable work is not covered by the new Stop admission guard. Successful local write does not prove CLI receipt. Transport references are retained until SDK session closure/reopen so late terminal turn diagnostics survive process cleanup. No real-account/model stress test, host UI verification, plugin reload, dependency upgrade or deployment was performed. Historical Gemini/high-thinking fault cause remains unknown.
- 老法师's final read-only re-review passed with no blockers. He independently reran all 240 tests, typecheck and diff check, verified both fixes and examined the red/green and five-run pressure logs. Approval covers source and local simulated validation only; source work is not a running-plugin update.

## 0.3.3 release: review hardening

- Baseline: 559def0 (v0.3.2), typecheck and all 169 tests passed before changes.
- Cancellation now snapshots pending permission request IDs as independent targets, including idle restored approvals. Seven new Watch regressions failed before the fix and pass after it; skip/replay real-SDK fixtures verify bounded Stop failure without an active turn.
- Removed silence-only process termination and its unused progress clock/limit. Long quiet prompts wait for native completion or explicit Stop. Startup/control deadlines, cancellation deadlines, process-group cleanup and transport failure handling remain. Unit clocks cover extended silence; SDK fixtures cross the former scaled silence threshold and verify both responsive cancellation and forced cleanup.
- SDK 0.17.3/0.17.4 settles pending permission promises on transport failure but emits no individual permission_resolved events in that path. runtime_failed is the host cleanup boundary. Actual UI dismissal remains unverified; fixture success is not a UI claim.
- Usage/installation errors are fixed diagnostics without raw output or causes; installation cancellation retains a safe AbortError. Invalid/non-positive reset timestamps become null while valid past timestamps and durations remain. Session usage merges scope.env over launch.env for identity and execution. Custom ACP data directories are rejected safely with distinct account keys, not silently queried through the default store.
- Read/search details retain existing text output; edit_file presentation inputs gain SDK aliases while native diffs remain authoritative. Tests cover empty/whitespace edits, structured outputs, nulls and a 500,000-character result. Missing approval rawInput becomes null, preserving 0.17.3 safety and 0.17.4 plain-text permission detail.
- Replacement tracking uses per-session clientMessageId sets settled by prompt_result events and admission rejection, not send Promise completion. Real-SDK tests cover rapid replacements and a rejected replacement that must not suppress the original turn's notice. Whole-turn steering statistics are unchanged, with new regressions for follow-up tools and old results.
- Shared CLI version parsing accepts v-prefixed versions; the minimum remains 1.5.15.
- Current checks: typecheck and all 218 automated tests pass on both @getpaseo/plugin 0.17.3 (worktree) and 0.17.4 (isolated /tmp dependency environment). The 0.17.4 run sets SDK_PERMISSION_DETAILS=1 to assert plain-text and edit approval presentation (including empty replacements and native diff priority). git diff --check passes. The worktree package/lock remain pinned to 0.17.3.
- Not implemented without reliable evidence: API Key no_quota classification (exit code 2 is ambiguous). Development validation did not include real model prompts, live quota probes, installed-plugin reload, native long-running stress tests or desktop/mobile UI verification. Release scope is the Git source, v0.3.3 tag and GitHub Release; no npm publication or running-plugin deployment. Full access ambiguity policy, wire approval IDs, frame limits and Paseo <0.18 compatibility are unchanged.
- 老法师 completed the initial read-only review: no confirmed blocking defect; independently passed typecheck and diff check, and inspected (not reran) the then-214-test logs. His follow-up identified missing async queued-failure and edit-permission coverage. Friday added admitted queued requests failing individually on close, clean reopen/empty-turn behavior, and 0.17.4 edit permission detail assertions; both SDK suites now pass 218 tests. A local agy acp --help check also exposed underscore data-directory aliases and --cli_dir_name; these now receive the same safe refusal and account isolation tests.
- Remaining identity uncertainty: account keys recognize HOME/ANTIGRAVITY_HOME and explicit ACP data-directory flags. Whether other environment selectors such as GEMINI_HOME change actual CLI quota identity has not been established; the adapter does not hash entire environments or secrets to guess identity. No claim of complete multi-account selector support is made.
- 老法师 also approved the added changes in a second read-only review, with no new confirmed defect. The close/reopen queued-failure fixture does not independently prove per-ID cleanup without closure, since session.closed also clears the queue. He inspected the updated 218-pass logs without rerunning tests. 氖元素 also approved the follow-up changes with no new confirmed defect; independently passed typecheck and diff check and inspected the two 218-pass logs (did not rerun integration tests). All implementation and follow-up changes were authored by the primary Friday agent.
- Non-blocking follow-ups retained after review: empty HOME/ANTIGRAVITY_HOME values can produce cwd-relative account keys (CLI fallback identity has not been verified); malformed/duplicate clientMessageId admission boundaries are not hardened beyond normal unique-ID inputs; Usage.launches retains environment snapshots without eviction. No speculative environment fallback or cache eviction policy was introduced, since either can change identity or invalidate still-used locators. Host rendering of thrown usage errors versus explicit error reports remains unverified.

## 0.3.2 release — turn-end notices and diagnostics

- Completed foreground-tool turns without subsequent nonblank assistant text emit one `antigravity-tool-only` info notice before the terminal turn event; failed tools are described as failures. Truly empty turns retain `antigravity-empty`. Canceled/replaced turns, detached tools, replay/retired echoes, synthetic completions and carry-over results cannot trigger the new notice.
- Watch tracks text and real tool terminals in wire order; detached classification matches the SDK's `IsDaemon` / named `schedule` policy. `[antigravity:prompt-end]` and `[antigravity:turn-end]` log single-line JSON metadata only: IDs, timestamps, state/allowlisted stop reason or numeric error code, flags and counts. No prompt, assistant/reasoning text, tool payload, path or raw error message is logged.
- Added 24 focused unit/real-SDK tests for parallel tools, opening/inter-tool/final text, same-chunk frames, deferred settlement, failed/detached tools, cancellation/replacement (including `end_turn` cancel replies), ownership/replay filtering and metadata privacy. Deferred tests scale only the SDK quiet window; replacement tests verify prompt counts.
- `pnpm typecheck`, all 169 tests (including the unchanged 145-test baseline) and `git diff --check` pass. Independent Neon and DeepSeek read-only reviews found no blocking defects; both independently passed these checks. No auto-retry, waiting notices or 15-minute watchdog changes.
- Release scope is Git source, the `v0.3.2` tag and GitHub Release. No live-account/UI validation, plugin reload or daemon restart was performed.

## 0.3.0 release

- Requires official agy >=1.5.15 and Paseo >=0.17.3 <0.18.0 on macOS/Linux.
- Includes the agy baseline and advisor follow-ups below, plus the previously unreleased ACP output, quiet-waiting and session-directory fixes.
- Release checks: typecheck, 145 automated tests and git diff --check pass. Neon completed two read-only review passes; an independent DeepSeek review found no new blocking defects and independently passed all 145 tests.
- Release scope is Git source plus a GitHub tag/release. This release was not installed/reloaded into the running daemon and has not received new real-account or UI validation. Historical live-validation records below apply only to their stated revisions.
- Non-blocking follow-ups: optional v-prefixed version output support, summary wording and additional timing fixtures. Complex native question/form behavior remains unverified.

## Historical baseline

The sections below retain their original validation context; “unreleased” identifies the stage at which those checks were recorded.

Environment: macOS, Paseo 0.17.3, official `agy` 1.5.15. This is a targeted follow-up to 0.2.1, not a new provider architecture.

## Neon advisor follow-up (unreleased)

- Independent Neon review reproduced a real-SDK same-chunk load/live race missed by the 260ms delayed fixture. The new same-chunk skip/replay cases failed before the fix.
- The transport now inserts a one-off scheduling barrier after a successful load response for the pinned SDK's asynchronous replay exit. This is not an output quiet timer. The first anonymous live text run receives an isolated stable message ID so it cannot append to anonymous historical text; native message IDs and content are unchanged.
- CLI version probing is shared by status and connect. Direct connections reject old/unrecognized versions and a missing acp argument. Mock-only tests explicitly inject a version checker rather than granting a production launch-argument bypass.
- Two independent Neon review passes identified the load scheduling race, direct-connect version bypass, synthetic-ID lifetime across prompts, and empty-string ID handling. The latter two were reproduced with new tests before fixing them: outgoing prompt/load clears the session-specific first-run identity, and empty IDs follow the pinned SDK\'s anonymous-message semantics.
- Added skip/replay real-SDK regressions for two pure-text prompts after restoration, both with and without prior autonomous output. Replies retain separate IDs and text, without synthetic restoration IDs leaking into user turns. Unit tests cover session isolation, repeated loads and empty IDs.
- Typecheck, all 145 tests and git diff --check pass after the final fixes. Neon independently ran the earlier 139-test suite; the final six tests and fixes were verified by the primary agent. No installation, reload or publication.
- SDK limitations remain: restoration approvals can precede session.opened and initial Full access configuration; permissions keyed by identical toolCallId can collide; an idle restored approval has no active turn for interrupt cleanup. Real host/UI behavior and native wire payloads require separate validation. Do not treat concurrent distinct-tool mock approvals as proof of those cases.

## agy 1.5.15 baseline (unreleased)

- Minimum supported CLI is now 1.5.15. Status checks reject older versions; fixtures cover 1.5.0, 1.5.14, 1.5.15, 1.5.16, 1.6.0, 2.0.0 and unrecognized version output. No CLI installation or upgrade was performed.
- Removed the transport's global 200ms replay quiet timer and the SDK's post-ready skip-until-prompt guard. Native history must precede the load response, as documented in upstream 1.5.15. Pre-1.5.15 late-history fixtures are intentionally replaced by this ordering, not retained as supported behavior.
- The watch exits replay on the native load response. Historical tools remain excluded; autonomous tools arriving afterward participate in cancellation tracking without needing a user prompt.
- A regression verifies a load reply precedes continuous live updates rather than waiting for silence. Real-SDK fixtures verify post-ready autonomous text/tool output in both skip/replay modes without a new prompt. Large fragmented Unicode history and a paused consumer remain covered using native response ordering.
- Real-SDK fixtures verify two pending approvals during restoration in both history modes, independently routed allow/deny replies in reverse order, and resolution events. These are synthetic standard ACP permissions, not proof of agy's proprietary forms, free-text questions, remote dismissal, or all Full access question behavior. Those require separate native protocol/UI validation.
- Command mapping preserves explicit kinds, recognizes swarm/thinking, and leaves unknown names neutral. The pinned SDK currently does not pass skill provenance from ACP, so this deliberately avoids claiming reliable skill classification.
- Typecheck and all 131 tests pass. The new transport/watch/version counterexamples failed before their fixes. No live model prompts, installed-plugin reload, deployment, or mobile UI validation were performed.
- Retained bounded cancellation/process cleanup, native-output mapping, and SDK background-tool deferral. Removing background deferral was not necessary for the replay fix and remains a separate compatibility decision.
- This section supersedes the replay-timer/late-history claims in older validation records below.

## ACP fidelity follow-up (unreleased)

- Tool text carried only in ACP `content` is exposed to the pinned SDK through `rawOutput` when no explicit `rawOutput` is present. Original content blocks, native structured output (including explicit null/empty values), and diffs are preserved. Snapshot updates replace text rather than accumulating duplicate content; shell details accept plain text output.
- Two wire-level counterexamples failed before the mapping fix. Real-SDK tests verify shell and MCP text results and native diff presentation.
- Empty-result warnings now require a completed turn with neither nonblank assistant text nor a live wire-confirmed completed/failed tool result. Watch excludes replay and retired tool echoes; SDK-synthesized terminal rows cannot suppress warnings. Pending calls and reasoning alone do not suppress warnings. Tests verify tool-only turns do not warn and a subsequent genuinely empty turn still does.
- A slow-consumer test exposed read-ahead growth: every consumed frame resumed another pipe chunk even when decoded frames remained queued. The transport now drains decoded frames before resuming stdout. The regression sends 2,000 Unicode frames (roughly 14 MB), confirms the producer remains backpressured after 600 slow reads, then verifies all frames arrive unchanged and in order.
- Additional pressure tests verify 10,000 fragmented mixed text/tool events and bounded cleanup when canceling an output flood. These are automated fixture tests, not a UI latency benchmark, RSS bound, or proof of indefinite memory stability.
- Independent review identified and prompted fixes for replay completing while stdout was paused, synthetic tool terminalization hiding empty results, stale fallback text after content replacement, and later content overriding native output. Regression tests cover all four, including real-SDK history ghosts/pending tools and structured shell output preservation.
- Replay quiet time does not advance to completion while stdout is paused; resumption starts a fresh quiet window. Output provenance is scoped by transport/session/tool and cleared on transport close. It stores only source markers, not payloads, and grows with distinct tools like SDK snapshots; no eviction is used because late updates must retain their native-output protection.
- All 119 automated tests, `pnpm typecheck`, and `git diff --check` pass. Both independent reviewers reran the tests and approved the fixes; rollback probes also confirmed the new regression tests detect the original failures.
- Explicit native `rawOutput` (including null/empty values) remains authoritative, even when content text also exists. Multiple text blocks are joined with a display newline; this is not a byte-for-byte stdout representation. Non-text blocks remain on the wire, but this fallback does not add SDK rendering support for images/audio/resources. ACP snapshot semantics are followed; agy-specific delta behavior has not been confirmed live.
- Empty-result warnings reflect the evidence available when the turn completes. A tool result that arrives afterward can coexist with an earlier warning; the warning is not retracted. The plugin does not delay completion indefinitely waiting for possible late output.
- Under an extremely stalled consumer, stdout backpressure can delay cancellation acknowledgments beyond the fixed timeout and trigger bounded process cleanup. Timeout protections remain enabled; this is not a guarantee of preserving a stalled runtime indefinitely.
- No live account prompts, installed-plugin reload, mobile UI validation, or deployment were performed for this follow-up.

## Issue #1 follow-up (unreleased)

- Removed both no-progress notices, their per-turn state and the 30-second hint timer setting. Idle sessions and quiet active turns now wait silently.
- Startup, cancellation and 15-minute inactivity failure handling are unchanged; foreground tools and pending approvals still prevent silence-only termination. Cleanup failures and empty-result warnings remain visible.
- `pnpm typecheck`, `git diff --check` and all 92 tests pass. Watch tests cover repeated quiet intervals, subsequent turns, idle sessions and long-running tools; real-SDK tests with a mock CLI verify quiet waiting and preserved concrete failure diagnostics.
- Documentation and plugin descriptions now describe quiet waiting. Existing timeline notices are not removed. No installed plugin reload, live CLI run or UI verification was performed for this change.

## Issue #2 follow-up (unreleased)

- Session-list `cwd` values are normalized before publication to Paseo, which validates the directory before `session.open`. No persistence, title, timestamp or transcript fields are rewritten.
- Explicit local file URLs are converted with `fileURLToPath`. Pathless `file://` and `file://localhost` inputs stay unchanged instead of becoming `/`; explicit root URLs still work. Ambiguous URLs, encoded separators/NULs (including `%5C` on POSIX) and encoded dot-segment traversal are left unchanged. Bare absolute paths are decoded at most once, only after the original entry returns `ENOENT` from `lstat` and the decoded path is an existing directory according to `stat`. Literal entries, dangling symlinks and unknown filesystem errors are preserved.
- Normalization is synchronous to preserve event order. Repeated cwd values share a result only within one `sessions` event; later events recheck the filesystem. This reduces duplicate I/O but does not impose a time bound on slow mounts.
- The original real-SDK regression failed before the fix for both an encoded Chinese directory and a file URL. Review follow-up counterexamples for pathless file URLs and dangling symlinks also failed before their fixes. All 91 tests and `pnpm typecheck` now pass on macOS with the pinned `@getpaseo/plugin` 0.17.3 development SDK.
- Twenty-five added tests cover Chinese/nested paths, spaces, special characters, literal percent names, one-pass decoding, valid/dangling symlinks, file URL boundaries, invalid encodings, unsafe paths, missing directories, files, filesystem errors, per-event deduplication, filesystem changes between lists, mixed/duplicate session rows and empty lists. The real SDK with a mock ACP server resumes the original native session using the corrected process directory, reports the corrected opened cwd and replays encoded transcript text unchanged.
- Real CLI validation passed with official `agy` 1.5.16 and `gemini-4-neon`: a new synthetic conversation in a temporary Chinese/space directory appeared in the unmodified SDK's list with an encoded cwd. The patched list restored its actual directory and preserved its metadata. Native filtering by the actual cwd found the same session; loading it with the corrected cwd succeeded and replayed the synthetic marker with the original persistence identity.
- Reproduce that opt-in check with `node --import tsx scripts/live-session-cwd.ts --confirm-live`. It uses the existing CLI subscription for one small synthetic prompt, denies permission requests, and prints only validation flags. It closes its runtimes and removes its temporary directory, but leaves the synthetic native history entry; no existing conversation is opened or prompted.
- The installed plugin and daemon were not changed. Actual import through the Paseo UI, including the reported daemon 0.17.4 environment, remains unverified. The release validation below is the previous 0.2.2 record, separate from this follow-up.

## Changes and regression evidence

| Issue | 0.2.2 fix and evidence |
| --- | --- |
| Late replay leaking after ready | Retains the transport's 200ms byte-aware boundary and sets SDK `loadReplayQuietPeriodMs` to 1 instead of 0. This preserves the SDK's `skip` guard until the first new prompt. Real-SDK tests cover both history modes, history arriving at 260ms, ghost tools, and the next prompt completing. Large fragmented UTF-8 replay remains covered. |
| Follow-up removing preserved background tools | Removed whole-turn `settle()` cleanup. Retires individual tools on explicit ACP terminal updates or SDK completed/failed/canceled tool events. A test keeps a background tool active across an auto follow-up beyond the scaled silence deadline, then verifies its completion. |
| Cancel deadline crossing into later work | Request IDs and tool IDs retain separate cancellation timestamps. Completing a target releases only its own deadline; later targets receive their own deadlines; repeated Stop does not postpone an existing deadline. Tests cover response order, repeated cancellation, new tools, and similar tool/request IDs. |
| Status probe cold-start inconsistency | Version check and handshake share a ~95-second budget. Recognized fixed transport diagnostics preserve sign-in guidance without exposing raw exec/SDK output or authorization URLs. Tests use scaled budgets for slow-start, timeout and redaction cases. |
| Final pre-sleep timer slice | Rebase stale timestamps older than 5 seconds and future timestamps after clock regression, including work started after the last tick. Preserve fresh post-wake cancellation deadlines. Tested with injected clocks, not a physical lid-close test. |
| Missing exit diagnostics | Flush final frames first, then wait at most 100ms for the exit event. Include an exit code or signal when available. Exit code 17 and SIGTERM are verified in both SDK runtime-failure and failed-turn events, including the generic `ACP connection closed` variant. |

## Verification

- Before implementation changes, six added counterexamples failed on 0.2.1: two late-replay modes, preserved background work, an old cancel killing a new request, a later cancellation inheriting an earlier deadline, and the pre-sleep final timer slice.
- `pnpm typecheck`, `git diff --check`, and all 66 tests pass.
- Corrected older unit tests that assumed a prompt/turn ending implied all tools ended. They now simulate explicit SDK tool-terminal events; real-SDK cancellation coverage still passes, and a new RPC-error integration test verifies stale tools do not poison the next turn.
- `pnpm test:live --confirm-live`: 9 models discovered; Gemini 4 Neon replies correctly, remembers the marker after native close/reload, cancels after visible streaming (8ms in this run), handles an immediate follow-up, and handles a new prompt 6 seconds after idle cancellation.
- Paseo's installed compiler built the server bundle. The plugin was reloaded only with no running Plus requests. A separate test agent using `gemini-4-neon` / `high` / `default` returned `PASEO_022_OK`; reloading that test agent and asking for the marker returned it again. No existing user conversation was prompted or archived.
- Installed usage source: `antigravity-plus`, `available`, 5 windows. No CLI login or credentials were changed.

## Limits

These checks validate the listed scenarios, not indefinite stability. Late-history protection follows the SDK's first-new-prompt boundary. Native SQLite/inbox/transcript inspection, hidden upstream-error classification, orphan-subagent detection, Windows support and Paseo 0.18 compatibility remain out of scope. Long tools that never report completion can still require manual Stop. Real long-running subagent stress testing and mobile visual testing were not performed.

During the earlier 0.2.1 installed test, one post-reload request exceeded 90 seconds without a reply; Stop, a subsequent new turn and a later reload succeeded. Its root cause remains unknown. The successful 0.2.2 checks do not retroactively diagnose that incident.

## Historical 0.2.1 validation record

The following is the previous release's record; its whole-turn cleanup and replay-timer assumptions are superseded by the 0.2.2 changes above.

Environment: macOS, Paseo 0.17.3, official `agy` 1.5.15.

## Issues Addressed

| Issue | 0.2.1 Resolution & Evidence |
| --- | --- |
| Idle cancel killing or poisoning next turn | Cancel deadline is armed only when active prompts or foreground tools exist; cleared when idle; follow-up prompts do not disarm an in-flight cancel. Verified by unit tests, SDK integration tests, and live CLI runs. |
| History replay and canceled tool-call leaks | `session/load` replay updates are excluded from live tool state; cancel and RPC failures clear transient state; SDK turn settlement clears stale tools; late updates for retired tool IDs are ignored. |
| Specific errors swallowed by SDK | Preserves the transport/watch failure reason before closing; replaces only known generic SDK messages (`ACP transport closed unexpectedly`, `Connection closed`, `ACP turn failed`) on `runtime_failed` and failed turns without overwriting meaningful upstream errors. |
| Process-group signal races | Extracted testable `stopGroup`; treats `ESRCH` as terminal without re-signaling; bounds `EPERM` retries; still attempts `SIGKILL` if `SIGTERM` fails; reports unconfirmed cleanup rather than hanging the close promise. |
| Large history replay truncation | Moved the 200ms quiet boundary into the byte-aware transport; holds the `session/load` response until no partial frame remains and the quiet window elapses while streaming history notifications inside the SDK replay window; disabled the SDK's second blind timer. Tested with 300 KB fragmented, multi-byte UTF-8 histories spanning >200ms. |
| Shutdown ordering and grace period | Calls `core.close()` first for native `session/close`; falls back to forced cleanup after 5s total grace; `SIGTERM` grace is 1s; concurrent `close()` calls share one promise. Verified when session open hangs. |
| EOF, EPIPE, and backpressure | Flushes `decoder.end()` and parses trailing frames without a newline on EOF; avoids immediately erroring the readable stream on `EPIPE`; does not fake EOF while a slow consumer pauses stdout. |
| Duplicate notices and invalid dismissal | Removed ineffective dismissal notifications; emits at most one no-progress notice per wire prompt turn. |
| Resource and config hygiene | Cleans up `hasText` on terminal events; unrefs monitor timers with a 10ms minimum interval; rejects non-positive watch limits; preserves command prefixes before `acp` in `inspect`; removed direct `esbuild` dependency. |
| Sleep / wake recovery | Detects timer gaps >5s or clock regressions and resets pre-sleep progress and request timers without resetting cancels issued after wake. Verified with injected clock tests (no physical lid-close test). |
| Status and usage reporting | Restored real ACP handshake and SSH environment hints in `status`; registered `antigravity-plus` usage source parsing `agy -p /usage --output-format json`; verified 5 live quota windows. |

## Automated & Live Verification

- All 6 regression cases added before the fix failed beforehand and pass after the fix.
- `pnpm typecheck` passes.
- `pnpm test` passes all 49 tests, including real Paseo SDK integration with a mock CLI fixture.
- Local Paseo compiler builds the server bundle cleanly and loads the plugin in `running` state.
- `pnpm test:live --confirm-live` verified against existing CLI login: 9 models discovered, live reply from Gemini 4 Neon, native session close/reload remembers context, mid-stream cancel returns `canceled`, immediate follow-up turn succeeds, and post-idle-cancel turn succeeds.
- Standalone `status` check verified CLI version check and ACP handshake; `usage` source returned `available` with 5 quota windows.
- Installed plugin verified end-to-end in Paseo (`gemini-4-neon`, thinking `high`, mode `default`), including stop/recovery and reload context persistence without auto-resending prompts.

## Known Boundaries

- Addresses known provider defects rather than guaranteeing immunity from upstream network, quota, or long-task failures. Normal long tools and pending approvals are not killed for silence; a tool that permanently fails to report a terminal state still requires manual stop.
- Does not read native session SQLite files, inboxes, or transcripts.
- Does not create an OAuth page, copy credentials, modify `GEMINI_HOME`, `SSH_*`, or `BROWSER`, or alter built-in providers or native session data.
- `Full access` remains opt-in; migration from built-in provider sessions, Windows support, and Paseo 0.18 compatibility are out of scope (`>=0.17.3 <0.18.0`).
- No-progress notices remain timeline history items in Paseo 0.17.3; mobile visual testing and heavy real-world long subagent stress tests were not performed.
