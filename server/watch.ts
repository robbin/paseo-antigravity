import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { Activity } from "./activity";
import { BackgroundTasks } from "./background-tasks";

export interface Limits {
  startup: number;
  cancel: number;
  quietDiag?: number;
  stall?: number;
}
export const defaults: Limits = {
  startup: 90_000,
  cancel: 5_000,
  stall: 150_000,
};
type Id = string | number;
// Scalar metadata only; completed/failed count foreground tools, results includes detached tools.
interface Turn {
  turnId: string;
  nativeSessionId?: string;
  startedAt: number;
  responseAt?: number;
  stopReason?: string;
  errorCode?: number;
  canceled: boolean;
  stopTokens: Set<number>;
  replaced: boolean;
  text: boolean;
  trailingText: boolean;
  results: number;
  completed: number;
  failed: number;
}
interface Call {
  method: string;
  session?: string;
  at: number;
  turn?: Turn;
}
interface Tool {
  status: string;
  detached: boolean;
  name?: string;
  kind?: string;
  turn?: Turn;
}
interface Session {
  prompts: Set<Id>;
  tools: Map<string, Tool>;
  approvals: Set<Id>;
  cancelPrompts: Map<Id, number>;
  cancelTools: Map<string, number>;
  cancelApprovals: Map<Id, number>;
  replay: boolean;
  retiredTools: Set<string>;
  background: BackgroundTasks;
}
export type WatchResult = { failure?: string; stall?: string };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One state per native session. Payloads are inspected only for background safety. */
export class Watch {
  private calls = new Map<Id, Call>();
  private sessions = new Map<string, Session>();
  private permissions = new Map<Id, string>();
  private stopOwners = new Map<number, Turn>();
  turn?: Turn;
  private recoveryDisabled = false;
  private quietSince?: number;
  private stallReported = false;
  readonly activity: Activity;
  constructor(readonly limits: Limits = defaults) {
    this.activity = new Activity(limits.quietDiag);
  }
  private counts() {
    let openPrompts = 0, openTools = 0, approvals = 0;
    for (const s of this.sessions.values()) {
      if (s.replay) continue;
      openPrompts += s.prompts.size;
      openTools += [...s.tools.values()].filter(t => !t.detached).length;
      approvals += s.approvals.size;
    }
    // Restored permissions count even during replay for Stop admission.
    return {openPrompts, openTools, approvals};
  }
  /** User input invalidates recovery immediately, before SDK admission/dispatch. */
  suspendRecovery() {
    this.recoveryDisabled = true;
    this.quietSince = undefined;
  }
  private safeWorkState() {
    return [...this.sessions.values()].every(s => !s.replay && !s.background.size &&
      !s.cancelPrompts.size && !s.cancelTools.size && !s.cancelApprovals.size);
  }
  canContinue() {
    const c = this.counts();
    return !this.turn && this.safeWorkState() &&
      c.openPrompts === 0 && c.openTools === 0 && c.approvals === 0;
  }
  private recoveryEligible() {
    const t = this.turn;
    // Any response in this SDK turn may mean deferred/steered work. Its interrupt
    // retires the runtime rather than just ending a wire prompt; never recover it.
    if (!t?.nativeSessionId || t.responseAt !== undefined || t.canceled ||
        t.stopTokens.size || this.recoveryDisabled) return false;
    const c = this.counts();
    return c.openPrompts === 1 && c.openTools === 0 && c.approvals === 0 && this.safeWorkState();
  }
  private reconcileRecovery(now: number) {
    if (!this.recoveryEligible()) this.quietSince = undefined;
    else this.quietSince ??= now;
  }
  requestStop(now = Date.now()): number | undefined {
    const c = this.counts();
    const approvals = [...this.sessions.values()].some(s => s.approvals.size);
    if (!this.turn && !c.openPrompts && !c.openTools && !approvals) return;
    const token = this.activity.requestStop(now);
    if (this.turn) {
      this.turn.stopTokens.add(token);
      this.stopOwners.set(token, this.turn);
    }
    return token;
  }
  settleStop(token: number, rejected = false) {
    const owner = this.stopOwners.get(token);
    if (owner) {
      owner.stopTokens.delete(token);
      // Acceptance remains an intent to stop even after its delivery settles.
      // Rejection rolls back only this token, on the captured original turn.
      if (!rejected) owner.canceled = true;
      this.stopOwners.delete(token);
    }
    this.activity.settleStop(token, rejected ? "rejected" : "settled");
  }
  endTurn(turnId: string, completed = true) {
    if (this.turn?.turnId !== turnId) return;
    const t = this.turn;
    if (completed && t.nativeSessionId && t.stopReason === "end_turn" &&
        t.errorCode === undefined && !t.canceled && !t.stopTokens.size && !t.replaced)
      this.sessions.get(t.nativeSessionId)?.background.endTurn(turnId);
    this.turn = undefined;
    this.quietSince = undefined;
    this.activity.end();
  }
  startTurn(turnId: string, now = Date.now()) {
    // Only scopes marked by a normal SDK+wire ending are released. Automatic
    // continuation follows cancellation, so cannot discharge its canceled scope.
    for (const s of this.sessions.values()) s.background.startTurn(turnId);
    this.activity.start(turnId, now);
    this.recoveryDisabled = false;
    this.quietSince = undefined;
    this.stallReported = false;
    this.turn = { turnId, startedAt: now, canceled: false, stopTokens: new Set(), replaced: false,
      text: false, trailingText: false, results: 0, completed: 0, failed: 0 };
  }
  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        prompts: new Set(),
        tools: new Map(),
        approvals: new Set(),
        cancelPrompts: new Map(),
        cancelTools: new Map(),
        cancelApprovals: new Map(),
        replay: false,
        retiredTools: new Set(),
        background: new BackgroundTasks(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
  private retireTool(s: Session, id: string) {
    s.tools.delete(id);
    s.cancelTools.delete(id);
    s.retiredTools.add(id);
    while (s.retiredTools.size > 2048)
      s.retiredTools.delete(s.retiredTools.values().next().value!);
  }
  /** A completed turn can preserve background tools. Only actual tool terminal events retire them. */
  finishTool(id: string, now = Date.now()) {
    for (const s of this.sessions.values())
      if (!s.replay && s.tools.has(id)) this.retireTool(s, id);
    this.reconcileRecovery(now);
  }
  /** Reset pre-suspension clocks, including the final timer slice, but preserve fresh post-wake work. */
  resume(now: number, lastTick: number) {
    const rebase = (at: number) =>
      (now < lastTick && at > now) || now - at > 5000 ? now : at;
    this.activity.resume(rebase);
    if (this.quietSince !== undefined) this.quietSince = rebase(this.quietSince);
    for (const c of this.calls.values()) c.at = rebase(c.at);
    for (const s of this.sessions.values()) {
      for (const [id, at] of s.cancelPrompts)
        s.cancelPrompts.set(id, rebase(at));
      for (const [id, at] of s.cancelTools) s.cancelTools.set(id, rebase(at));
      for (const [id, at] of s.cancelApprovals)
        s.cancelApprovals.set(id, rebase(at));
    }
  }
  observe(direction: "out" | "in", frame: AcpStreamMessage, now: number): void {
    this.observeFrame(direction, frame, now);
    this.reconcileRecovery(now);
  }
  private observeFrame(direction: "out" | "in", frame: AcpStreamMessage, now: number): void {
    const m = frame as unknown as Record<string, unknown>;
    const id =
      typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
    const p = record(m.params);
    const sid = typeof p.sessionId === "string" ? p.sessionId : undefined;
    if (direction === "out") {
      if (typeof m.method === "string" && id !== undefined) {
        this.calls.set(id, { method: m.method, session: sid, at: now,
          turn: m.method === "session/prompt" ? this.turn : undefined });
        if (m.method === "session/load" && sid)
          this.session(sid).replay = true;
        if (m.method === "session/prompt" && sid) {
          if (this.turn) this.turn.nativeSessionId = sid;
          const s = this.session(sid);
          s.replay = false;
          s.prompts.add(id);
        }
      }
      if (m.method === "session/cancel" && sid) {
        if (this.turn?.nativeSessionId === sid) this.turn.canceled = true;
        const s = this.session(sid);
        // Snapshot only the targets that exist now. Repeated Stop keeps each old
        // target's first deadline; newly targeted work receives its own deadline.
        for (const id of s.prompts)
          if (!s.cancelPrompts.has(id)) s.cancelPrompts.set(id, now);
        for (const [id, tool] of s.tools)
          if (!tool.detached && !s.cancelTools.has(id))
            s.cancelTools.set(id, now);
        // Restored approvals may have no active prompt or live tool at all.
        for (const id of s.approvals)
          if (!s.cancelApprovals.has(id)) s.cancelApprovals.set(id, now);
      }
      if (!m.method && id !== undefined) {
        const session = this.permissions.get(id);
        if (session) {
          const s = this.session(session);
          s.approvals.delete(id);
          s.cancelApprovals.delete(id);
          this.permissions.delete(id);
        }
      }
      return;
    }
    if (!m.method && id !== undefined) {
      const call = this.calls.get(id);
      this.calls.delete(id);
      if (call?.method === "session/load" && call.session)
        this.session(call.session).replay = false;
      if (call?.method === "session/prompt" && call.session) {
        const s = this.session(call.session);
        s.prompts.delete(id);
        s.cancelPrompts.delete(id);
        if (call.turn === this.turn) this.activity.incoming("response", now);
        if (call.turn) {
          const t = call.turn, reason = record(m.result).stopReason;
          t.responseAt = now;
          t.stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(String(reason))
            ? String(reason) : "unknown";
          const code = record(m.error).code;
          if (typeof code === "number") t.errorCode = code;
          console.log("[antigravity:prompt-end]", JSON.stringify({ ...turnMetadata(t),
            openTools: [...s.tools.values()].filter(t => !t.detached).length }));
        }
        // Tool and approval completion comes from explicit wire/SDK events, not
        // from a prompt's stop reason, which may coexist with other active work.
      }
    }
    if (m.method === "session/request_permission" && sid && id !== undefined) {
      const s = this.session(sid);
      s.approvals.add(id);
      // Permission requests can be the only frame carrying daemon/launcher input.
      // Retain that safety evidence even if the SDK auto-approves immediately.
      const tool = record(p.toolCall);
      if (!s.replay && typeof tool.toolCallId === "string") {
        const name = typeof tool.name === "string" ? tool.name :
          (typeof tool.title === "string" && ["run_command", "invoke_subagent", "schedule"].includes(tool.title) ? tool.title : undefined);
        const kind = typeof tool.kind === "string" ? tool.kind : undefined;
        s.background.observe(tool.toolCallId, name, tool,
          this.turn?.nativeSessionId === sid ? this.turn.turnId : undefined, kind);
      }
      this.permissions.set(id, sid);
      if (!s.replay && this.turn?.nativeSessionId === sid)
        this.activity.incoming("permission", now);
    }
    if (m.method !== "session/update" || !sid) return;
    const u = record(p.update),
      s = this.session(sid);
    const priorTool = typeof u.toolCallId === "string" ? s.tools.get(u.toolCallId) : undefined;
    const name = typeof u.name === "string" ? u.name : priorTool?.name ??
      (typeof u.title === "string" && ["run_command", "invoke_subagent", "schedule"].includes(u.title) ? u.title : undefined);
    const kind = typeof u.kind === "string" ? u.kind : priorTool?.kind;
    if (s.replay) {
      if (typeof u.toolCallId === "string") this.retireTool(s, u.toolCallId);
      return;
    }
    // Live late exit evidence still matters after a background launcher row retired,
    // but retired non-background tool echoes must never manufacture a new guard.
    // Replay is history, never evidence of a currently running daemon/job.
    if (typeof u.toolCallId === "string" &&
        (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
        (!s.retiredTools.has(u.toolCallId) || s.background.has(u.toolCallId))) {
      s.background.observe(u.toolCallId, name, u,
        this.turn?.nativeSessionId === sid ? this.turn.turnId : undefined, kind);
    }
    if (typeof u.toolCallId === "string" && s.retiredTools.has(u.toolCallId)) return;
    const turn = this.turn?.nativeSessionId === sid ? this.turn : undefined,
      content = record(u.content);
    // Carry-over tools retain their owner. Their completion (and retired echoes)
    // must not look like progress by a newer, otherwise silent prompt.
    if (turn && (!priorTool || priorTool.turn === turn))
      this.activity.incoming(u.sessionUpdate, now);
    if (turn && u.sessionUpdate === "agent_message_chunk" &&
        content.type === "text" && typeof content.text === "string" && content.text.trim())
      turn.text = turn.trailingText = true;
    if (typeof u.toolCallId === "string") {
      const old = s.tools.get(u.toolCallId),
        input = record(u.rawInput);
      const tool: Tool = {
        name,
        kind,
        turn: old ? old.turn : turn, // Carry-over tools retain their original owner.
        status:
          typeof u.status === "string" ? u.status : (old?.status ?? "pending"),
        detached:
          old?.detached === true ||
          input.IsDaemon === true ||
          (name === "schedule" && typeof input.CronExpression === "string" &&
            input.CronExpression.trim().length > 0),
      };
      if (["completed", "failed", "cancelled"].includes(tool.status)) {
        if (turn && tool.turn === turn && (u.status === "completed" || u.status === "failed")) {
          turn.results++;
          if (!tool.detached) {
            turn[u.status]++;
            turn.trailingText = false;
          }
        }
        this.retireTool(s, u.toolCallId);
      }
      else s.tools.set(u.toolCallId, tool);
    }
  }
  check(now: number): WatchResult {
    for (const call of this.calls.values()) {
      if (
        call.method !== "session/prompt" &&
        now - call.at >= this.limits.startup
      )
        return {
          failure: `Antigravity timed out during ${call.method}. Check the local CLI and network, then refresh the session.`,
        };
    }
    for (const s of this.sessions.values()) {
      if (
        [...s.cancelPrompts.values(), ...s.cancelTools.values(),
          ...s.cancelApprovals.values()].some(
          (at) => now - at >= this.limits.cancel,
        )
      )
        return {
          failure:
            "Antigravity did not finish the cancel request in time; closed this session process without resending the message.",
        };
    }
    const failure = this.activity.check(now, this.limits.cancel, this.counts());
    if (failure) return {failure};
    this.reconcileRecovery(now);
    const since = this.quietSince;
    if (since !== undefined && !this.stallReported &&
        now - Math.max(since, this.activity.lastActivityAt ?? since) >= (this.limits.stall ?? defaults.stall!)) {
      this.stallReported = true;
      return {stall: this.turn!.turnId};
    }
    return {};
  }
}

/** Stable legacy log schema; new counters must not leak through object spreading. */
export function turnMetadata(t: Turn) {
  return {turnId:t.turnId, nativeSessionId:t.nativeSessionId, startedAt:t.startedAt,
    responseAt:t.responseAt, stopReason:t.stopReason, errorCode:t.errorCode,
    canceled:t.canceled || t.stopTokens.size > 0, replaced:t.replaced, text:t.text, trailingText:t.trailingText,
    results:t.results, completed:t.completed, failed:t.failed};
}
