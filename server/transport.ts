import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { Watch, defaults, type Limits } from "./watch";
import { stopProcessGroup } from "./process-group";
import { ToolResultMapper } from "./tool-results";
import { LoadBoundary } from "./load-boundary";

export interface Context {
  cwd: string;
  env: Readonly<Record<string, string>>;
  sessionId?: string;
}
export interface OwnedTransport {
  stream: AcpStream;
  close(): Promise<void>;
  finished: Promise<void>;
  pid: number | undefined;
  watch: Watch;
}
const MAX_FRAME = 16 * 1024 * 1024;
function parse(line: string): AcpStreamMessage {
  if (
    line.startsWith("Open the following link to authenticate") ||
    line.startsWith("https://accounts.google.com/")
  )
    throw new Error(
      "官方 CLI 要求登录。请在该主机终端使用现有 agy 登录；插件不会收集授权码。",
    );
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Error(
      "Antigravity stdout 返回了非 ACP 数据。请检查 CLI 版本和登录状态。",
    );
  }
  if (!v || typeof v !== "object" || !("jsonrpc" in v) || v.jsonrpc !== "2.0")
    throw new Error("无效的 ACP 消息。");
  if (
    "method" in v &&
    v.method === "session/request_permission" &&
    "params" in v
  ) {
    const params = v.params as { toolCall?: Record<string, unknown> };
    if (params?.toolCall && params.toolCall.rawInput === undefined)
      params.toolCall.rawInput = null;
  }
  return v as AcpStreamMessage;
}

/** Own the official CLI and its process group. No credentials or raw stderr are logged. */
export function createTransport(
  launch: ProviderLaunch,
  context: Context,
  hint: (message: string) => void,
  limits: Limits = defaults,
  onFailure: (message: string) => void = () => {},
): OwnedTransport {
  if (process.platform === "win32")
    throw new Error("当前进程管理实现仅支持 macOS / Linux。");
  for (const [key, value] of Object.entries(limits)) {
    if (key === "quietDiag" && value === undefined) continue;
    if (value === undefined || !Number.isFinite(value) || value <= 0)
      throw new Error("Watch 时间限制必须是正数。");
  }
  const child = spawn(launch.command, launch.args, {
    cwd: context.cwd,
    env: { ...launch.env, ...context.env },
    shell: false,
    detached: true,
    stdio: "pipe",
  });
  const watch = new Watch(limits);
  const toolResults = new ToolResultMapper();
  const loadBoundary = new LoadBoundary();
  let boundaryPending = false;
  let releaseBoundary: (() => void) | undefined;
  const yieldTurn = () => new Promise<void>((resolve) => {
    const timer = setTimeout(done, 0);
    function done() {
      clearTimeout(timer);
      releaseBoundary = undefined;
      resolve();
    }
    releaseBoundary = done;
  });
  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  let controller: ReadableStreamDefaultController<AcpStreamMessage>;
  let closed = false,
    closing: Promise<void> | undefined,
    failure: string | undefined;
  let rejectPendingWrite: (() => void) | undefined;
  let groupClosing: Promise<string | undefined> | undefined;
  const stopOwned = () => (groupClosing ??= stopProcessGroup(child.pid));
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitInfo:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let exited!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    exited = resolve;
  });
  let ending: Promise<void> | undefined;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const recordFailure = (message: string) => {
    if (!failure) {
      failure = message;
      onFailure(message);
    }
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* consumer already cancelled */
        }
      }
      releaseBoundary?.();
      toolResults.clear();
      clearInterval(timer);
      clearTimeout(exitTimer);
      // A Web Streams abort/close queues behind an in-flight write. Release it
      // from this owned, out-of-band close path before waiting for process reap.
      rejectPendingWrite?.();
      child.stdin.destroy();
      watch.activity.clear();
      try {
        const error = await stopOwned();
        if (error) {
          recordFailure(error);
          hint(error);
        }
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    })().finally(finish));
  const fail = (message: string) => {
    if (closed) return;
    recordFailure(message);
    closed = true;
    controller.error(new Error(message));
    void close();
  };
  const deliver = (frame: AcpStreamMessage) => {
    watch.observe("in", frame, Date.now());
    controller.enqueue(toolResults.map(frame));
  };
  // agy >=1.5.15 finishes history before the load response. Preserve wire order;
  // a live session need not become quiet after that boundary.
  const consume = () => {
    let pos: number;
    while ((pos = buffer.indexOf("\n")) >= 0) {
      if (pos > MAX_FRAME) throw new Error("Antigravity 消息超过大小限制。");
      const line = buffer.slice(0, pos).trim();
      buffer = buffer.slice(pos + 1);
      if (line) deliver(parse(line));
    }
    if (buffer.length > MAX_FRAME)
      throw new Error("Antigravity 消息超过大小限制。");
  };
  const endOutput = (): Promise<void> =>
    (ending ??= (async () => {
      if (closed) return;
      try {
        buffer += decoder.end();
        consume();
        if (buffer.trim()) deliver(parse(buffer.trim()));
        buffer = "";
        // stdout EOF can precede Node's exit event. Briefly wait for metadata without
        // delaying delivery of already parsed final replies or inventing a failure code.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exitObserved,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 100);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (closed) return;
        const detail = exitInfo?.signal
          ? `（信号 ${exitInfo.signal}）`
          : typeof exitInfo?.code === "number"
            ? `（退出码 ${exitInfo.code}）`
            : "";
        recordFailure(
          `Antigravity CLI 已关闭输出或退出${detail}。请刷新会话后继续；未重发消息。`,
        );
        // close() preserves queued replies; error() would discard them.
        void close();
      } catch (e) {
        fail(e instanceof Error ? e.message : "ACP 尾帧错误。");
      }
    })());
  const drainThenClose = () => {
    if (!closed && !exitTimer) {
      // Do not manufacture EOF while stdout is paused with unread final frames.
      // Reap pipe-holding descendants; only the real stdout 'end' flushes the decoder.
      exitTimer = setTimeout(() => {
        void stopOwned().then((error) => {
          if (error) {
            recordFailure(error);
            hint(error);
            void close();
          }
        });
      }, 1000);
      exitTimer.unref();
    }
  };
  const interval = Math.max(
    10,
    Math.min(500, limits.startup, limits.cancel, limits.quietDiag ?? 120_000),
  );
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > interval + 5000 || now < lastTick)
      watch.resume(now, lastTick);
    lastTick = now;
    const result = watch.check(now);
    if (result.failure) fail(result.failure);
  }, interval);
  timer.unref();
  const source = new ReadableStream<AcpStreamMessage>({
    start(c) {
      controller = c;
    },
    cancel() {
      return close();
    },
  });
  const reader = source.getReader();
  const stream: AcpStream = {
    readable: new ReadableStream<AcpStreamMessage>({
      async pull(c) {
        if (boundaryPending) {
          boundaryPending = false;
          // Fixed SDK 0.17.3 drains notifications via setTimeout(0) after load.
          // First yield lets its continuation register that timer; the second
          // lets it finish before live frames enter the RPC reader. Never wait
          // for upstream silence. Close interrupts either scheduling turn.
          await yieldTurn();
          if (!closed) await yieldTurn();
        }
        // Drain already-decoded frames before resuming the pipe. Resuming on
        // every read lets each consumed frame admit another whole pipe chunk,
        // so a slow consumer can otherwise accumulate the producer's output.
        if (
          !closed &&
          controller.desiredSize !== null &&
          controller.desiredSize > 0
        ) {
          child.stdout.resume();
        }
        try {
          const next = await reader.read();
          if (next.done) {
            loadBoundary.clear();
            c.close();
          }
          else {
            const mapped = loadBoundary.incoming(next.value);
            boundaryPending = mapped.boundary;
            c.enqueue(mapped.frame);
          }
        } catch (e) {
          c.error(e);
        }
      },
      cancel(reason) {
        loadBoundary.clear();
        return reader.cancel(reason);
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(frame) {
        if (closed) throw new Error(failure ?? "Antigravity 连接已关闭。");
        loadBoundary.outgoing(frame);
        watch.observe("out", frame, Date.now());
        const seq = watch.activity.writeStart("method" in frame ? frame.method : undefined, Date.now());
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const complete = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            rejectPendingWrite = undefined;
            watch.activity.writeEnd(seq, !error, Date.now());
            if (error) reject(new Error(failure ?? "Antigravity 连接已关闭。"));
            else resolve();
          };
          rejectPendingWrite = () => complete(new Error("closed"));
          try {
            child.stdin.write(JSON.stringify(frame) + "\n", error => {
              if (settled) return;
              if (error && !closed) {
                recordFailure("Antigravity 输入管道已关闭。");
                drainThenClose();
              }
              complete(error);
            });
          } catch {
            recordFailure("Antigravity 输入管道写入失败。");
            drainThenClose();
            complete(new Error("write failed"));
          }
        });
      },
      close,
      abort: close,
    }),
  };
  child.once("error", () =>
    fail("无法启动官方 agy，请检查 Paseo 的可执行文件路径。"),
  );
  child.stdin.on("error", () => {
    if (!closed) {
      recordFailure("Antigravity 输入管道已关闭。");
      drainThenClose();
    }
  });
  child.stdout.on("error", () => fail("Antigravity 输出管道读取失败。"));
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      buffer += decoder.write(chunk);
      consume();
      if (controller.desiredSize !== null && controller.desiredSize <= 0)
        child.stdout.pause();
    } catch (e) {
      fail(e instanceof Error ? e.message : "ACP 协议错误。");
    }
  });
  child.stdout.once("end", endOutput);
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    exited();
    if (child.stdout.readableEnded) void endOutput();
    else drainThenClose();
  });
  return {
    stream,
    close,
    finished,
    pid: child.pid,
    watch,
  };
}
