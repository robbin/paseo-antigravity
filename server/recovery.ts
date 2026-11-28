import { randomUUID } from "node:crypto";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { OwnedTransport } from "./transport";

export interface RecoveryConfig {
  enabled: boolean;
  stallMs: number;
  maxContinuations: number;
}
export interface RecoveryOptions {
  enabled?: boolean;
  maxContinuations?: number;
  backoffBaseMs?: number;
  getConfig?: () => RecoveryConfig;
}
export const recoveryDefaults = {
  maxContinuations: 3,
  backoffBaseMs: 2_000,
} as const;
const MAX_BACKOFF_MS = 60_000;

interface Chain {
  messageId: string;
  attempts: number;
  progressSeen: boolean;
  stallMs?: number;
  turnId?: string;
  cancelId?: string;
  cancelDelivered?: boolean;
  canceled?: boolean;
  continuationDisabled?: boolean;
  outputSeen?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
interface Ports {
  transport(sessionId: string): OwnedTransport | undefined;
  pending(sessionId: string): boolean;
  send(input: ProviderInput): Promise<void>;
  emit(event: ProviderEvent): void;
}
export function continuationPrompt(stallMs: number) {
  return `[System Auto-Recovery] The previous upstream streaming response was silent for over ${stallMs / 1000}s, so the stalled connection was automatically canceled. Strictly continue remaining steps based on existing tool outputs and current disk state—do not repeat completed writes, commands, or external actions. Verify any uncertain side effects first, ask the user if unsure, and do not retry blindly; if the task is already complete, report the result directly. Continue in the same language as the conversation.`;
}

/** Provider-level coordinator. Never writes ACP frames or fabricates SDK turns.
 * Chain object identity is the generation fence; admission is not completion.
 */
export class Recovery {
  private chains = new Map<string, Chain>();
  private cancelRequests = new Map<string, { sessionId: string; chain: Chain }>();
  // Ownership survives user invalidation until the SDK settles the internal input.
  // Match actual submissions, never just a clientMessageId prefix.
  private promptRequests = new Map<string, string>();
  private readonly defaultEnabled: boolean;
  private readonly defaultMaxContinuations: number;
  private readonly backoffBaseMs: number;
  private readonly getConfig?: () => RecoveryConfig;
  constructor(
    private readonly ports: Ports,
    private readonly defaultStallMs: number,
    options: RecoveryOptions = {},
  ) {
    const max = options.maxContinuations ?? recoveryDefaults.maxContinuations;
    const base = options.backoffBaseMs ?? recoveryDefaults.backoffBaseMs;
    if (!Number.isInteger(max) || max < 0)
      throw new Error("Recovery maxContinuations must be a non-negative integer.");
    if (!Number.isFinite(base) || base < 0)
      throw new Error("Recovery backoffBaseMs must be a non-negative finite number.");
    this.defaultEnabled = options.enabled ?? true;
    this.defaultMaxContinuations = max;
    this.backoffBaseMs = base;
    this.getConfig = options.getConfig;
  }

  private currentConfig(): RecoveryConfig {
    if (!this.getConfig) {
      return {
        enabled: this.defaultEnabled,
        stallMs: this.defaultStallMs,
        maxContinuations: this.defaultMaxContinuations,
      };
    }
    const raw = this.getConfig();
    return {
      enabled: raw.enabled === true,
      stallMs: Number.isFinite(raw.stallMs) && raw.stallMs > 0 ? raw.stallMs : this.defaultStallMs,
      maxContinuations:
        Number.isInteger(raw.maxContinuations) && raw.maxContinuations >= 0
          ? raw.maxContinuations
          : this.defaultMaxContinuations,
    };
  }

  invalidate(sessionId: string) {
    const chain = this.chains.get(sessionId);
    clearTimeout(chain?.timer);
    this.chains.delete(sessionId);
    this.ports.transport(sessionId)?.watch.suspendRecovery();
  }
  userInput(input: ProviderInput) {
    if (!("sessionId" in input)) return;
    if (input.type === "session.prompt") {
      this.invalidate(input.sessionId);
      this.chains.set(input.sessionId, {
        messageId: input.prompt.clientMessageId,
        attempts: 0,
        progressSeen: false,
      });
    } else if (["session.interrupt", "session.close", "session.open"].includes(input.type)) {
      this.invalidate(input.sessionId);
    }
  }
  /** Apply runtime settings updates immediately to in-flight/pending continuation chains. */
  onConfigChange() {
    const cfg = this.currentConfig();
    for (const [sessionId, chain] of [...this.chains.entries()]) {
      // Turning recovery off irreversibly invalidates any in-flight cancel or
      // backoff continuation so re-enabling later cannot resurrect an old plan.
      if (!cfg.enabled && (chain.cancelId || chain.timer)) {
        chain.continuationDisabled = true;
      }
      if (!chain.timer) continue;
      const stopReason = this.stopReasonFor(chain, cfg);
      if (!stopReason) continue;
      clearTimeout(chain.timer);
      chain.timer = undefined;
      this.stopChain(sessionId, chain, stopReason, cfg);
    }
  }
  private live(sessionId: string, chain: Chain) {
    return this.chains.get(sessionId) === chain && this.ports.transport(sessionId)?.usable === true;
  }
  private stopReasonFor(
    chain: Chain,
    cfg = this.currentConfig(),
  ): "disabled" | "exhausted" | "no-progress" | undefined {
    if (chain.continuationDisabled || !cfg.enabled || cfg.maxContinuations === 0) return "disabled";
    if (chain.attempts >= cfg.maxContinuations) return "exhausted";
    if (chain.attempts > 0 && !chain.progressSeen) return "no-progress";
    return undefined;
  }
  private backoffMs(nextAttempt: number) {
    if (this.backoffBaseMs === 0) return 0;
    return Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** (nextAttempt - 1));
  }
  private notice(sessionId: string, phase: string, title: string, severity: "info" | "warning" = "warning") {
    this.ports.emit({type: "session.notice", sessionId,
      notice: {id: `antigravity-recovery-${phase}`, severity, title}});
  }
  private log(sessionId: string, chain: Chain, phase: string, cfg = this.currentConfig()) {
    console.log("[antigravity:recovery]", JSON.stringify({
      sessionId,
      turnId: chain.turnId,
      phase,
      continuationUsed: chain.attempts > 0,
      attempt: chain.attempts,
      maxContinuations: cfg.maxContinuations,
      stallMs: chain.stallMs ?? cfg.stallMs,
    }));
  }
  private stopChain(
    sessionId: string,
    chain: Chain,
    stopReason: "disabled" | "exhausted" | "no-progress",
    cfg: RecoveryConfig,
  ) {
    if (this.chains.get(sessionId) !== chain) return;
    this.log(sessionId, chain, stopReason, cfg);
    this.invalidate(sessionId);
    const disabledBySwitch = !cfg.enabled || chain.continuationDisabled === true;
    const title = stopReason === "disabled"
      ? disabledBySwitch
        ? "Upstream stream stalled; stopped automatically (auto-recovery disabled). Check the current state and continue manually."
        : "Upstream stream stalled; stopped automatically (automatic continuation disabled). Check the current state and continue manually."
      : stopReason === "no-progress"
        ? `No substantive progress after automatic continuation (${chain.attempts}/${cfg.maxContinuations}); stopped automatically. Check the current state and continue manually.`
        : `Upstream stream stalled again after ${chain.attempts}/${cfg.maxContinuations} automatic continuations; stopped automatically. Check the current state and continue manually.`;
    this.notice(sessionId, "stopped", title);
  }
  stall(sessionId: string, turnId: string) {
    const cfg = this.currentConfig();
    if (!cfg.enabled) return;
    const chain = this.chains.get(sessionId);
    if (!chain || chain.turnId !== turnId || chain.cancelId || !this.live(sessionId, chain)) return;
    if (this.ports.pending(sessionId)) {
      this.ports.transport(sessionId)?.watch.clearStallReported(turnId);
      return;
    }
    if (chain.attempts > 0 && this.ports.transport(sessionId)?.watch.turnProgress(turnId).progress)
      chain.progressSeen = true;
    const requestId = `antigravity-recovery:${randomUUID()}`;
    chain.cancelId = requestId;
    chain.stallMs = cfg.stallMs;
    this.cancelRequests.set(requestId, {sessionId, chain});
    this.log(sessionId, chain, "cancel-requested", cfg);
    const stopReason = this.stopReasonFor(chain, cfg);
    const title = stopReason === "disabled"
      ? `Upstream stream silent for over ${chain.stallMs / 1000}s; auto-cancel triggered (automatic continuation disabled).`
      : stopReason === "exhausted"
        ? `Upstream stream stalled again after ${chain.attempts}/${cfg.maxContinuations} automatic continuations; stopping automatically.`
        : stopReason === "no-progress"
          ? `No substantive progress after automatic continuation (${chain.attempts}/${cfg.maxContinuations}); stopping automatically without another retry.`
          : `Upstream stream silent for over ${chain.stallMs / 1000}s; auto-cancel triggered. Will attempt continuation ${chain.attempts + 1}/${cfg.maxContinuations} after clean cancel.`;
    this.notice(sessionId, "cancel", title);
    // Notice listeners can synchronously deliver a user Stop/new message.
    if (!this.live(sessionId, chain)) {
      this.cancelRequests.delete(requestId);
      return;
    }
    void this.ports.send({type: "session.interrupt", sessionId, requestId}).catch(() => {
      this.cancelRequests.delete(requestId);
      this.abort(sessionId, chain);
    });
  }
  private abort(sessionId: string, chain: Chain) {
    if (this.chains.get(sessionId) !== chain) return;
    this.log(sessionId, chain, "aborted");
    this.invalidate(sessionId);
    this.notice(sessionId, "aborted", "Auto-recovery did not meet safe shutdown conditions; skipped continuation. Check the current state and continue manually.");
  }
  private schedule(sessionId: string, chain: Chain) {
    if (!chain.canceled || !chain.cancelDelivered || chain.timer || !this.live(sessionId, chain)) return;
    const cfg = this.currentConfig();
    const stopReason = this.stopReasonFor(chain, cfg);
    if (stopReason) {
      this.stopChain(sessionId, chain, stopReason, cfg);
      return;
    }
    const nextAttempt = chain.attempts + 1;
    // Always defer at least one macrotask so SDK activePrompt.settled/finally
    // clears the old turn, plus exponential backoff (2s -> 4s -> 8s by default).
    chain.timer = setTimeout(() => {
      chain.timer = undefined;
      const transport = this.ports.transport(sessionId);
      if (!this.live(sessionId, chain)) return;
      const latestCfg = this.currentConfig();
      const latestStop = this.stopReasonFor(chain, latestCfg);
      if (latestStop) {
        this.stopChain(sessionId, chain, latestStop, latestCfg);
        return;
      }
      if (this.ports.pending(sessionId) || !transport?.watch.canContinue()) {
        this.abort(sessionId, chain);
        return;
      }
      const stallMs = chain.stallMs ?? latestCfg.stallMs;
      chain.attempts = nextAttempt; // Consume BEFORE admission; never refund an attempted continuation.
      chain.progressSeen = false;
      chain.outputSeen = false;
      chain.messageId = `antigravity-continuation:${randomUUID()}`;
      chain.turnId = undefined;
      chain.cancelId = undefined;
      chain.cancelDelivered = chain.canceled = false;
      this.log(sessionId, chain, "continuing", latestCfg);
      this.notice(sessionId, "continuing", `Upstream stream silent for over ${stallMs / 1000}s; auto-canceled and started deduplicated continuation (${chain.attempts}/${latestCfg.maxContinuations}).`, "info");
      if (!this.live(sessionId, chain)) return;
      // Notice listeners can synchronously submit session.configure or other
      // session work; recheck all gates before admitting an automatic prompt.
      if (this.ports.pending(sessionId) || !this.ports.transport(sessionId)?.watch.canContinue()) {
        this.abort(sessionId, chain);
        return;
      }
      const messageId = chain.messageId;
      this.promptRequests.set(messageId, sessionId);
      void this.ports.send({type: "session.prompt", sessionId, prompt: {
        clientMessageId: chain.messageId, delivery: "auto",
        input: {type: "message", content: [{type: "text", text: continuationPrompt(stallMs)}]},
      }}).catch(() => {
        this.promptRequests.delete(messageId);
        this.abort(sessionId, chain);
      });
    }, this.backoffMs(nextAttempt));
    chain.timer.unref();
  }
  /** Consume internal request receipts only; SDK turn/timeline events stay public. */
  event(event: ProviderEvent, wireStopReason?: string): boolean {
    if (event.type === "request.completed" || event.type === "request.failed") {
      const request = this.cancelRequests.get(event.requestId);
      if (!request) return false;
      this.cancelRequests.delete(event.requestId);
      const {sessionId, chain} = request;
      if (event.type === "request.failed") this.abort(sessionId, chain);
      else {
        chain.cancelDelivered = true;
        this.schedule(sessionId, chain);
      }
      return true;
    }
    if (!("sessionId" in event)) return false;
    const sessionId = event.sessionId;
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      const chain = this.chains.get(sessionId);
      if (chain?.cancelId || chain?.attempts) this.abort(sessionId, chain);
      else this.invalidate(sessionId);
      return false;
    }
    const chain = this.chains.get(sessionId);
    const internalPrompt = event.type === "session.prompt_result" &&
      this.promptRequests.get(event.clientMessageId) === sessionId;
    if (internalPrompt && event.type === "session.prompt_result")
      this.promptRequests.delete(event.clientMessageId);
    if (event.type === "session.prompt_result" && chain?.messageId === event.clientMessageId) {
      if (event.result.type === "turn") chain.turnId = event.result.turnId;
      else if (event.result.type === "steer") {
        // Deferred SDK turns have a process-retiring interrupt path; stay protected.
        this.invalidate(sessionId);
      } else if (chain.attempts > 0) this.abort(sessionId, chain);
      else this.invalidate(sessionId);
    }
    // provider.ts has already called forgetReplacement; binding above must run
    // before hiding the receipt, otherwise the started turn would lose its owner.
    if (internalPrompt) return true;
    if (event.type === "session.turn") {
      if (event.state === "started") {
        if (!chain || chain.turnId !== event.turnId)
          this.ports.transport(sessionId)?.watch.suspendRecovery();
      } else if (chain?.turnId === event.turnId) {
        if (chain.cancelId) {
          if (event.state === "canceled" && wireStopReason === "cancelled") {
            chain.canceled = true;
            this.schedule(sessionId, chain);
          } else this.abort(sessionId, chain);
        } else {
          if (chain.attempts > 0 && event.state !== "completed") this.abort(sessionId, chain);
          else {
            if (chain.attempts > 0) this.log(sessionId, chain, "finished");
            this.invalidate(sessionId);
          }
        }
      }
    }
    if (event.type === "timeline.item" && chain && chain.attempts > 0 && chain.turnId && !chain.cancelId) {
      // Rely on Watch's wire-level turn ownership so stale/retired tool echoes
      // forwarded by the SDK cannot fabricate resumed activity or progress.
      const state = this.ports.transport(sessionId)?.watch.turnProgress(chain.turnId);
      if (state?.progress) chain.progressSeen = true;
      if (state?.resumed && !chain.outputSeen) {
        chain.outputSeen = true;
        const cfg = this.currentConfig();
        const displayMax = Math.max(chain.attempts, cfg.maxContinuations);
        this.log(sessionId, chain, "output-resumed", cfg);
        this.notice(sessionId, "resumed", `Auto-recovery active: model resumed work (${chain.attempts}/${displayMax}).`, "info");
      }
    }
    return false;
  }
  close() {
    for (const sessionId of this.chains.keys()) this.invalidate(sessionId);
    this.cancelRequests.clear();
    this.promptRequests.clear();
  }
}
