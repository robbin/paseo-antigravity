import { randomUUID } from "node:crypto";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { OwnedTransport } from "./transport";

interface Chain {
  messageId: string;
  used: boolean;
  turnId?: string;
  cancelId?: string;
  cancelDelivered?: boolean;
  canceled?: boolean;
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
  constructor(private readonly ports: Ports, private readonly stallMs: number) {}

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
      this.chains.set(input.sessionId, {messageId: input.prompt.clientMessageId, used: false});
    } else if (["session.interrupt", "session.close", "session.open"].includes(input.type)) {
      this.invalidate(input.sessionId);
    }
  }
  private live(sessionId: string, chain: Chain) {
    return this.chains.get(sessionId) === chain && this.ports.transport(sessionId)?.usable === true;
  }
  private notice(sessionId: string, phase: string, title: string, severity: "info" | "warning" = "warning") {
    this.ports.emit({type: "session.notice", sessionId,
      notice: {id: `antigravity-recovery-${phase}`, severity, title}});
  }
  private log(sessionId: string, chain: Chain, phase: string) {
    console.log("[antigravity:recovery]", JSON.stringify({sessionId, turnId: chain.turnId,
      phase, continuationUsed: chain.used, stallMs: this.stallMs}));
  }
  stall(sessionId: string, turnId: string) {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.turnId !== turnId || chain.cancelId ||
        !this.live(sessionId, chain) || this.ports.pending(sessionId)) return;
    const requestId = `antigravity-recovery:${randomUUID()}`;
    chain.cancelId = requestId;
    this.cancelRequests.set(requestId, {sessionId, chain});
    this.log(sessionId, chain, "cancel-requested");
    this.notice(sessionId, "cancel", chain.used
      ? "Upstream stream stalled again after automatic continuation; stopping automatically without another continuation."
      : `Upstream stream silent for over ${this.stallMs / 1000}s; auto-cancel triggered. Will attempt continuation after clean cancel (max 1).`);
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
    if (chain.used) {
      this.log(sessionId, chain, "exhausted");
      this.invalidate(sessionId);
      this.notice(sessionId, "stopped", "Upstream stream stalled again after automatic continuation; stopped automatically. Check the current state and continue manually.");
      return;
    }
    // A macrotask lets SDK activePrompt.settled/finally clear the old turn. A
    // synchronous send in session.turn would interrupt that still-active turn again.
    chain.timer = setTimeout(() => {
      chain.timer = undefined;
      const transport = this.ports.transport(sessionId);
      if (!this.live(sessionId, chain)) return;
      if (this.ports.pending(sessionId) || !transport?.watch.canContinue()) {
        this.abort(sessionId, chain);
        return;
      }
      chain.used = true; // Consume BEFORE admission; never refund an attempted continuation.
      chain.messageId = `antigravity-continuation:${randomUUID()}`;
      chain.turnId = undefined;
      chain.cancelId = undefined;
      chain.cancelDelivered = chain.canceled = false;
      this.log(sessionId, chain, "continuing");
      this.notice(sessionId, "continuing", `Upstream stream silent for over ${this.stallMs / 1000}s; auto-canceled and started deduplicated continuation (max 1).`, "info");
      if (!this.live(sessionId, chain)) return;
      const messageId = chain.messageId;
      this.promptRequests.set(messageId, sessionId);
      void this.ports.send({type: "session.prompt", sessionId, prompt: {
        clientMessageId: chain.messageId, delivery: "auto",
        input: {type: "message", content: [{type: "text", text: continuationPrompt(this.stallMs)}]},
      }}).catch(() => {
        this.promptRequests.delete(messageId);
        this.abort(sessionId, chain);
      });
    }, 0);
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
      if (chain?.cancelId || chain?.used) this.abort(sessionId, chain);
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
      } else if (chain.used) this.abort(sessionId, chain);
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
          if (chain.used && event.state !== "completed") this.abort(sessionId, chain);
          else {
            if (chain.used) this.log(sessionId, chain, "finished");
            this.invalidate(sessionId);
          }
        }
      }
    }
    if (event.type === "timeline.item" && chain?.used && chain.turnId && !chain.cancelId &&
        !chain.outputSeen && ["assistant_message", "reasoning"].includes(event.item.type)) {
      chain.outputSeen = true;
      this.log(sessionId, chain, "output-resumed");
    }
    return false;
  }
  close() {
    for (const sessionId of this.chains.keys()) this.invalidate(sessionId);
    this.cancelRequests.clear();
    this.promptRequests.clear();
  }
}
