// Content-free transport observations. No protocol payload or raw errors are retained.
const methods = new Set(["initialize", "session/new", "session/load", "session/prompt",
  "session/cancel", "session/set_mode", "session/set_config_option", "session/close"]);
let nextTransportId = 0;
export interface ActivityCounts { openPrompts: number; openTools: number; approvals: number }
export class Activity {
  private readonly transportId = ++nextTransportId;
  private sequence = 0;
  private stops = new Map<number, {at: number; turnId?: string}>();
  private pending?: { seq: number; method: string; at: number };
  private live?: { turnId: string; at: number; last: number; first?: number; lastInbound?: number;
    lastWrite?: number; reported: boolean; responses: number;
    text: number; thought: number; tool: number; approval: number; compaction: number };
  constructor(private readonly quietMs = 120_000) {}
  start(turnId: string, now: number) {
    this.live = { turnId, at: now, last: now, reported: false, responses: 0,
      text: 0, thought: 0, tool: 0, approval: 0, compaction: 0 };
  }
  end() { this.live = undefined; }
  requestStop(now: number): number {
    const token = ++this.sequence;
    this.stops.set(token, {at: now, turnId: this.live?.turnId});
    this.stopLog("requested", token);
    return token;
  }
  settleStop(token: number, phase: "settled" | "rejected" = "settled") {
    if (!this.stops.has(token)) return;
    this.stopLog(phase, token);
    this.stops.delete(token);
  }
  private stopLog(phase: "requested" | "settled" | "rejected" | "timeout", token: number) {
    console.log("[antigravity:stop]", JSON.stringify({ transportId: this.transportId, turnId: this.stops.get(token)?.turnId, phase, token,
      pendingWrite: this.pending?.method ?? null }));
  }
  writeStart(method: unknown, now: number): number {
    const seq = ++this.sequence;
    this.pending = {seq, at: now, method: typeof method === "string" && methods.has(method) ? method : "other"};
    return seq;
  }
  writeEnd(seq: number, ok: boolean, now: number) {
    if (this.pending?.seq !== seq) return;
    this.pending = undefined;
    if (ok && this.live) this.live.last = this.live.lastWrite = now;
  }
  incoming(kind: unknown, now: number) {
    const l = this.live;
    if (!l) return;
    l.first ??= now;
    l.last = l.lastInbound = now;
    switch (kind) {
      case "agent_message_chunk": l.text++; break;
      case "agent_thought_chunk": l.thought++; break;
      case "tool_call": case "tool_call_update": l.tool++; break;
      case "permission": l.approval++; break;
      case "compaction_update": case "compaction_summary_chunk": l.compaction++; break;
      case "response": l.responses++; break;
    }
  }
  resume(rebase: (at: number) => number) {
    for (const stop of this.stops.values()) stop.at = rebase(stop.at);
    if (this.pending) this.pending.at = rebase(this.pending.at);
    const l = this.live;
    if (l) {
      l.at = rebase(l.at); l.last = rebase(l.last);
      if (l.first !== undefined) l.first = rebase(l.first);
      if (l.lastInbound !== undefined) l.lastInbound = rebase(l.lastInbound);
      if (l.lastWrite !== undefined) l.lastWrite = rebase(l.lastWrite);
    }
  }
  check(now: number, cancelMs: number, counts: ActivityCounts): string | undefined {
    for (const [token, stop] of this.stops) if (now - stop.at >= cancelMs) {
      this.stopLog("timeout", token);
      return "Antigravity 停止请求未能及时完成传输，已关闭本会话进程；未重发消息。";
    }
    const l = this.live;
    if (l && !l.reported && now - l.last >= this.quietMs) {
      l.reported = true;
      const age = (at: number | undefined) => at === undefined ? null : Math.max(0, now - at);
      console.log("[antigravity:quiet]", JSON.stringify({
        transportId: this.transportId, turnId: l.turnId,
        turnAgeMs: age(l.at), quietAgeMs: age(l.last),
        firstInboundAgeMs: age(l.first), lastInboundAgeMs: age(l.lastInbound),
        lastWriteCompletedAgeMs: age(l.lastWrite),
        pendingWrite: this.pending?.method ?? null, pendingWriteAgeMs: age(this.pending?.at),
        openPrompts: counts.openPrompts, openTools: counts.openTools, approvals: counts.approvals,
        promptResponses: l.responses, textEvents: l.text, thoughtEvents: l.thought,
        toolEvents: l.tool, approvalEvents: l.approval, compactionEvents: l.compaction,
      }));
    }
  }
  clear() { this.stops.clear(); this.pending = undefined; this.live = undefined; }
}
