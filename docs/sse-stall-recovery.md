# Guarded upstream SSE stall recovery

## Motivation and evidence boundary

The incident investigation supplied for this change correlated `acp-server-*.log`, `daemon.log` and Mihomo's live connection table: TCP stayed `ESTABLISHED`, while Google's `daily-cloudcode-pa.googleapis.com` `streamGenerateContent?alt=sse` stopped sending SSE after partial reasoning without `END_STREAM`. The closed-source `agy` client has no SSE inter-chunk idle-read timeout. The native `session/prompt` consequently never resolves and Paseo remains `running`.

This is a Google server-side SSE stall combined with a missing `agy` streaming-read timeout, not a defect originating in this plugin. The new mechanism is an outer ACP safety net. It neither repairs nor directly probes the Google stream. Automated fixtures validate the safety net, not the original network diagnosis. No private endpoint, SQLite, transcript store or undocumented Paseo host module is used.

## Gate 1: eligible inactivity, not elapsed task time

`Watch` maintains a recovery eligibility clock separately from the existing approximately 120-second `quietDiag` diagnostic. The default recovery threshold is `150_000` ms (`limits.stall`, overridable through the `testOptions.limits` dependency injection, e.g. `provider({limits: {startup: 3000, cancel: 80, stall: 150}})` in tests). Both thresholds use finite positive values; omitted `stall` uses the default, preserving existing `Limits` callers. There is no new daemon setting.

Eligibility requires all of:

- An SDK-started turn associated with a native session and exactly one unresolved wire prompt.
- `openPrompts === 1 && openTools === 0 && approvals === 0`.
- No load replay, cancellation targets, Stop intent or observed unfinished background work.
- No earlier prompt response within this SDK turn. This deliberately excludes deferred turns and their steering prompts: SDK 0.17.3 can retire their entire process when interrupted.
- A current user-input generation owned by the coordinator; no pending replacement prompt or session control request.

Any gate closing discards the current eligible interval. Reopening starts a full fresh interval, rather than accumulating time spent on tools/approvals. Live activity and successful local writes restart silence; a local write is not evidence that the CLI processed it. Continued thought/text chunks allow arbitrarily long turns. Startup/control and cancellation deadlines still take precedence.

The transport's existing timer-gap detector calls `watch.resume(now, lastTick)` after a gap over five seconds or a backwards clock jump. The new eligibility clock is rebased with existing activity/cancel clocks: pre-suspend and future-dated clocks move to wake time, while fresh post-wake work retains its timestamps. Recovery never uses time asleep as eligible silence. Checks run at the existing bounded polling interval, so 150 seconds is a threshold, not a precise wall-clock deadline.

### Background evidence and release policy

The review supplied additional `agy 1.5.18` field evidence: an ordinary `run_command` running for more than 10 seconds can return a background-launch result, then complete through an independent `<SYSTEM_MESSAGE>` callback before the turn ends normally. Its original `toolCallId` need not ever receive a numeric `exit_code` update. Keeping every such marker for the transport lifetime would permanently disable recovery in long or restored sessions. The revised policy therefore distinguishes two live scopes and ignores replay evidence.

Background guards are separate from foreground tool rows. `ToolResultMapper`, SDK tool terminalization and `finishTool()` cannot clear them. Live `session/request_permission.toolCall` is inspected too, because it may be the only frame carrying daemon/launcher input before SDK auto-approval. Replay tool/permission payloads never create or clear guards; pending permissions themselves still block recovery until answered.

| Live ACP evidence (`!s.replay`) | Protection scope | Release condition |
| --- | --- | --- |
| Non-daemon `run_command` output contains `Tool is running as a background task` or `task id:` (case insensitive) | Turn-scoped | Normal native `end_turn` plus SDK `completed`, then the next user turn starts; alternatively a later explicit same-call numeric command exit |
| `invoke_subagent`, or one-shot `schedule` with absent/empty/whitespace `CronExpression` | Turn-scoped | Same normal turn boundary followed by the next user turn; launcher completion or callback prose alone never releases it |
| `rawInput.IsDaemon === true`, or `schedule` with nonempty `CronExpression` | Transport-scoped, live only | Explicit same-call numeric exit as described below, or transport disposal; survives normal turn boundaries |
| Background text on an otherwise unknown live tool | Turn-scoped | Same normal turn boundary; no guessed individual job-completion contract |
| Historical tool/permission payload during `session/load` replay | No new background guard | History does not prove a live job exists, including historical daemon/cron records |

Normal turn release requires `stopReason: end_turn`, SDK `completed`, and no cancellation intent, replacement or recorded RPC error. `Watch.endTurn()` only marks the owning turn's scopes releasable; `startTurn()` actually removes those marked scopes. Cancellation, failure, `max_tokens`, replacement or a wire reply without SDK completion cannot release them. An automatic continuation follows cancellation and therefore cannot discharge that canceled turn's guards. Unowned autonomous live work attaches to the next SDK turn and stays protected until that turn reaches the same normal boundary. This policy does not erase foreground tool tracking, unresolved approvals or live persistent guards.

An explicit exit means a later same-`toolCallId` update with `completed`/`failed` and finite numeric `rawOutput.exit_code`, without a background-launch text marker. It can release an ordinary recognized background command or any established persistent guard (including cron). Echoed `IsDaemon`/cron input does not negate an explicit exit; partial updates cannot downgrade a persistent scope. Ordinary async-launcher exit-shaped output is not sufficient. A generic terminal tool row, missing marker, callback prose, timeout or new user message alone never discharges a guard.

The known tool name can come from `name`, its preceding live snapshot, or an exact known-name `title` fallback. Background text is inspected transiently in `rawOutput` strings, its `output`/`text`/`content` string fields, and ACP text content blocks. The registry retains only call identity, scope, owning turn, completion flag and command/async classification, plus released-call identity tombstones to ignore late echoes. No output or native task IDs are retained. Live exit evidence is considered before retired-row filtering, so it remains usable after a launcher row retires. All this metadata is transport-owned.

The normal-turn boundary follows the supplied callback lifecycle evidence, not a universal ACP guarantee about every hidden job. Persisted daemon jobs are not reconstructed from historical transcripts; they need new live evidence to acquire protection. Work that never reports recognizable live evidence is unobservable. Abnormal turn endings or live persistent jobs without a reliable exit may still require manual Stop or transport closure. An absolute guarantee against every hidden upstream job is not possible at this layer.

## Gate 2: public SDK lifecycle and one continuation

Reviewed contract: pinned `@getpaseo/plugin` 0.17.3 public `server/acp` and `server/provider` types, and its ACP connection implementation. Production imports use public entrypoints only; SDK internals were read to verify behavior, never imported or mutated.

| Stage | Action / invariant |
| --- | --- |
| Eligible stall | `Watch.check()` returns one turn-scoped stall signal. Coordinator checks generation, transport usability and replacement queue again. |
| Cancel | Send public Provider `session.interrupt` with a fresh internal request ID. SDK calls ACP `session/cancel`; do not write directly to stdin or create an unmanaged RPC ID. |
| Delivery bound | The ordinary provider send path reserves the ID and creates the existing provisional Stop token before dispatch. Admission rejection rolls it back; SDK request completion/failure releases it. The wire cancel retains its per-target timeout. Both use the default 5 seconds. |
| Wait | Require both SDK `request.completed` for this internal interrupt and `session.turn` state `canceled` for the captured original turn, with native `stopReason: cancelled`. `end_turn`, failed cancellation or runtime closure never qualifies. |
| SDK settlement barrier | Schedule a macrotask, not a synchronous send or a single microtask. SDK emits the terminal turn before `activePrompt.settled.finally` clears its old active prompt. Waiting avoids treating the continuation as a replacement and issuing a second cancel. |
| Final gate | Recheck the same chain object, healthy same session transport, no pending replacements/session control requests and `watch.canContinue()` (no live turn, prompts, tools, approvals, background jobs or replay/cancel targets). |
| Continue once | Consume the allowance before admission and send a new public `session.prompt`, `delivery: auto`, with a fresh UUID message ID and fixed anti-duplication text. No original prompt, command, images, attachment or credentials are retained/copied. Failed admission does not refund/retry the attempt. |
| Second eligible stall | Cancel through the same path. On normal canceled settlement, stop idle with an exhaustion notice; no second continuation. Cancellation failure still uses existing runtime-failure/process cleanup. |

The SDK remains the sole owner of native RPCs, `session.prompt_result`, `session.turn`, streamed timeline snapshots and transient tool terminalization. Its continuation emits a visible user-message row containing the system-recovery instruction, a distinct prompt result and turn start, all normal streamed output, then a real terminal event. The text label `[系统自动恢复]` is explanatory text, not an elevated protocol role. Both internal interrupt acknowledgements and internal continuation `session.prompt_result` receipts are consumed by the wrapper; all turn/timeline events remain visible to the host.

In pinned SDK 0.17.3, `AcpRuntime.prompt()` emits `timeline.item` → `session.prompt_result` → `session.turn: started` locally; it does not await a host acknowledgement of that receipt. Public `ProviderEvent` associates a prompt result with the submitting caller's `clientMessageId`. The wrapper is the caller for automatic continuations: `provider.ts` first calls `forgetReplacement`, then `Recovery.event()` binds `chain.turnId` or handles failure, and only then returns `true` to consume that internal receipt. A separate exact-message-ID/session ownership map survives user invalidation until the receipt settles, so late success/failure receipts are consumed without reviving an old chain. A host-chosen ID merely resembling `antigravity-continuation:...` is not filtered. Admission rejection releases internal ownership; provider close clears the map. No private host module or alternate lifecycle machinery is used.

The wrapper's existing `replacements` set still tracks every admitted non-steer prompt until its `session.prompt_result` or admission rejection. Continuation also uses that path, but is not submitted until the original turn ended, so it cannot mark that original as replaced. Cancellation intent suppresses the original empty/tool-only notice. A genuinely empty completed continuation can still produce the normal empty-result notice; recovery must not conceal a real empty response.

### User priority and generation fencing

Any new user prompt (including a steer attempt) invalidates an old pending/awaited continuation immediately and creates a fresh allowance. The new chain binds to a turn only through the corresponding SDK `session.prompt_result`, not by assuming all subsequent `started` events belong to it. Rapidly queued older messages therefore cannot borrow the latest message's allowance. Steer results are protected because they belong to SDK-deferred turns.

User Stop, session close/open, runtime failure and provider close invalidate the chain and clear timers. Invalidation happens before SDK admission; even a rejected user input conservatively cancels pending automatic recovery. It never rolls that plan back into existence. Automatic requests use the same send/Stop/replacement infrastructure without masquerading as new user input or resetting the allowance. Object identity fences late timer, acknowledgement and admission callbacks. Notices may synchronously cause user input, so the coordinator checks again after emitting a cancellation/continuation notice. Pending session control requests also block continuation: SDK 0.17.3 has no public operation to retract an already-admitted prompt queued behind a configuration mutation. The plugin refuses that queueing opportunity rather than promising to unsend it. Once a new prompt has begun SDK dispatch, subsequent Stop/new input uses the normal interrupt/replacement path.

Transport `usable` becomes false immediately on close, failure, EOF handling or observed process exit, not only after process-group cleanup finishes. A failed/closed transport never gets automatically reopened. Normal cancellation reuses the same native session; it is not a reconnect or original-prompt retry.

### Anti-duplication prompt

Default text:

> [系统自动恢复] 上一轮上游流式响应静默超过 150 秒，已自动中断卡死连接。请严格基于已有工具输出和当前磁盘状态继续未完成步骤，切勿重复执行已成功完成的写入、命令或外部动作；先核对不确定的副作用，无法确认时询问用户，不要盲目重试；若任务实际已完成，请直接汇报结果。

This constrains behavior but cannot guarantee exactly-once external actions. A canceled response cannot prove that an upstream action never executed. Users must inspect uncertain side effects. Completely silent legitimate thinking past the threshold is indistinguishable from a stall when all observed gates pass.

## Gate 3: transparency without sensitive diagnostics

The successful recovery path emits just two supported `session.notice` cards: cancellation requested (`cancel`) and continuation started (`continuing`). First resumed text/reasoning output and normal completion write only `[antigravity:recovery]` phases `output-resumed` and `finished`; the user already sees the streamed reply and terminal turn. Abnormal outcomes retain `aborted` and second-stall `stopped` notices. A second stall also reports its new cancellation request. A request-to-cancel notice does not falsely claim that cancellation already completed, and `stopped` is emitted only after normal cancellation settlement. Notice IDs are stable phase identifiers; existing timeline history is not deleted or dismissed.

`[antigravity:recovery]` logs allow only `sessionId`, optional `turnId`, fixed `phase`, `continuationUsed` and `stallMs`. Existing `[antigravity:quiet]`, `[antigravity:stop]`, `[antigravity:prompt-end]` and `[antigravity:turn-end]` schemas are preserved. No payloads, reasoning, tool names/results, native task IDs, paths, environment, authorization URLs or raw errors are added. This guarantee covers plugin-generated diagnostic logs, not every SDK-native error or the user-visible conversation timeline.

The five-second Stop fallback has two phases (delivery and canceled targets), plus scheduling and process-group cleanup. It is not a promise of five seconds from stall detection to process reaping. If cancellation does not settle, existing cleanup closes only this session's owned process group and no continuation is attempted.

## Validation and remaining acceptance

See `VALIDATION.md` for actual commands/results. Tests use injected clock/threshold values, the pinned real SDK, and a local mock ACP subprocess. They do not consume a real account, connect to Google, install the plugin or restart Paseo. New tests cover gates, turn-scoped release, live persistent carry-over, replay exclusion, clock rebasing, internal receipt consumption with public SDK turn/timeline ordering, bounded notices, privacy, user races, a second stall and process cleanup. Existing tests remain part of the full run.

Remaining acceptance: desktop/mobile rendering and running-to-idle transitions on the installed host, real `agy` background callback shapes, physical sleep/wake, and long real-account sessions. Source verification alone is not deployment. Minimum Paseo remains `>=0.17.3`; the development SDK remains pinned to 0.17.3.

## 中文要点

本次机制是针对现场确认的“Google SSE 停吐 + 闭源 agy 缺少块间读超时”的外层兜底，不将其归咎于插件，不直接访问 Google 私有端点。默认 150 秒只累计符合门禁的静默；思考／正文持续输出、前台工具、审批、回放、已识别后台任务以及休眠重算均有保护。

自动取消和续接全部走公开 Provider → 官方 ACP SDK。原轮必须正常 `cancelled` 收尾，取消投递也已完成，再跨一个事件循环调度回合确认 SDK 已清理旧轮状态后才能续接。新续接提示有独立消息 ID、可见时间线和完整新轮次，绝不复制原始用户 prompt。内部 prompt_result 在清理 replacements、绑定续接轮次后由插件消费，不向宿主发送其未提交消息的回执；turn 与 timeline 事件照常透传。成功路径只发中断、开始续接两条通知，正常新输出与完成只记结构化日志；异常终态保留提示。每条新用户消息最多一次续接；第二次静默仅停止。用户 Stop／新消息、异常断连始终优先，失败不重试。

后台启动器“completed”不能解除本轮保护。普通非 daemon 后台命令、子代理与一次性 schedule 的单轮保护，须等原生 end_turn、SDK 正常完成且无取消／替换，再在下一轮开始时清理；异常收尾不清理。仅 live 启动的 IsDaemon／周期 schedule 跨轮保护至显式数字退出码终态或 transport 关闭。历史回放不建立后台保护，避免旧记录永久封杀新轮次恢复；恢复态后台工作仍需新的 live 证据。防重提示不是动作恰好执行一次的保证。真实宿主 UI 呈现、物理休眠唤醒与线上自然撞上 SSE 停吐时的恢复分支仍需在日常使用中持续观察。
