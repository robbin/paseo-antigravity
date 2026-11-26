import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

export interface GroupOps {
  signal(signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  /** Monotonic elapsed time, not wall-clock time. */
  now(): number;
}
/** ESRCH is terminal: never signal that numeric group again after it has disappeared. */
export async function stopGroup(
  ops: GroupOps,
  graceMs = 1000,
): Promise<string | undefined> {
  let gone = false;
  const attempt = async (
    signal: NodeJS.Signals | 0,
  ): Promise<"ok" | "gone" | "denied"> => {
    if (gone) return "gone";
    for (let retry = 0; retry < 3; retry++) {
      try {
        ops.signal(signal);
        return "ok";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          gone = true;
          return "gone";
        }
        if (code !== "EPERM") return "denied";
        // macOS can return EPERM until SIGCHLD has reaped an exited leader.
        if (retry < 2) await ops.sleep(25);
      }
    }
    return "denied";
  };
  if ((await attempt("SIGTERM")) === "gone") return;
  const until = ops.now() + Math.max(0, graceMs);
  while (ops.now() < until) {
    const state = await attempt(0);
    if (state === "gone") return;
    if (state === "denied") break;
    await ops.sleep(20);
  }
  // A failed graceful signal must not skip the force-stop attempt.
  if ((await attempt("SIGKILL")) === "denied")
    return "无法确认 Antigravity 进程组已回收（系统拒绝信号）。请检查本机进程权限。";
}
export function stopProcessGroup(pid: number | undefined, graceMs = 1000) {
  return pid === undefined
    ? Promise.resolve(undefined)
    : stopGroup(
        {
          signal: (s) => {
            process.kill(-pid, s);
          },
          sleep,
          now: () => performance.now(),
        },
        graceMs,
      );
}
