const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** Inspect known output shapes transiently; retain neither output nor task IDs. */
function texts(update: Record<string, unknown>): string[] {
  const output = update.rawOutput, fields = record(output);
  const result = [output, fields.output, fields.text, fields.content]
    .filter((v): v is string => typeof v === "string");
  if (Array.isArray(update.content)) for (const entry of update.content) {
    const block = record(entry), content = record(block.content);
    if (block.type === "content" && content.type === "text" && typeof content.text === "string")
      result.push(content.text);
  }
  return result;
}

interface Guard {
  scope: "turn" | "transport";
  kind: "command" | "async";
  turnId?: string;
  normallyEnded?: boolean;
}

/** Live evidence only. A completed launcher is NOT a completed job. Ordinary
 * callback-based jobs protect their turn; daemons/cron protect the transport.
 */
export class BackgroundTasks {
  private pending = new Map<string, Guard>();
  // Retain identities, never payloads, to prevent late launcher echoes from
  // resurrecting a scope already released at a normal turn boundary/process exit.
  private released = new Set<string>();
  get size() { return this.pending.size; }

  endTurn(turnId: string) {
    for (const guard of this.pending.values())
      if (guard.scope === "turn" && guard.turnId === turnId) guard.normallyEnded = true;
  }
  startTurn(turnId: string) {
    for (const [id, guard] of this.pending) {
      if (guard.scope !== "turn") continue;
      if (guard.normallyEnded) this.release(id);
      // Autonomous live work without an SDK turn is protected through the next
      // turn, not mistaken for historical work or silently discarded.
      else guard.turnId ??= turnId;
    }
  }
  private release(id: string) {
    this.pending.delete(id);
    this.released.add(id);
  }
  observe(id: string, name: string | undefined, update: Record<string, unknown>, turnId?: string) {
    if (this.released.has(id)) return;
    const input = record(update.rawInput), old = this.pending.get(id);
    const backgroundText = texts(update).some(text =>
      /Tool is running as a background task|\btask\s+id\s*:/i.test(text));
    const persistent = input.IsDaemon === true || (name === "schedule" &&
      typeof input.CronExpression === "string" && input.CronExpression.trim().length > 0);
    const exit = record(update.rawOutput).exit_code;
    if (old && (old.scope === "transport" || old.kind === "command") && !backgroundText &&
        typeof exit === "number" && Number.isFinite(exit) &&
        (update.status === "completed" || update.status === "failed")) {
      this.release(id);
      return;
    }
    if (persistent || backgroundText || name === "invoke_subagent" || name === "schedule") {
      // Partial updates never downgrade a persistent guard or change its owner.
      this.pending.set(id, {
        scope: persistent || old?.scope === "transport" ? "transport" : "turn",
        kind: old?.kind ?? (name === "run_command" ? "command" : "async"),
        turnId: old?.turnId ?? turnId,
        normallyEnded: old?.normallyEnded,
      });
    }
  }
}
