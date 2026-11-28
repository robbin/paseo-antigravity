import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import {
  MAX_CONTINUATIONS_MAX,
  MAX_CONTINUATIONS_MIN,
  STALL_RECOVERY_DEFAULTS,
  STALL_TIMEOUT_SECONDS_MAX,
  STALL_TIMEOUT_SECONDS_MIN,
  parseMaxContinuations,
  parseStallTimeoutSeconds,
  stallRecoverySettings,
  stallRecoverySettingsSchema,
  type StallRecoverySettings,
} from "../shared/settings.ts";
import {
  createRecoverySettingsStore,
  type StallRecoverySettingsHandle,
  type StallRecoverySettingsState,
} from "../server/settings-store.ts";
import { Watch } from "../server/watch.ts";
import { Recovery, type RecoveryConfig } from "../server/recovery.ts";
import type { OwnedTransport } from "../server/transport.ts";
import { provider } from "../server/provider.ts";

function createMockSettingsHandle(initial: StallRecoverySettingsState) {
  let state = initial;
  const listeners = new Set<(next: StallRecoverySettingsState) => void | Promise<void>>();
  let unsubscribed = 0;
  let readDelay: Promise<void> | undefined;
  let failRead = false;
  let onReadStarted: (() => void) | undefined;

  const handle: StallRecoverySettingsHandle = {
    async read() {
      // Capture the snapshot at call start so delayed read() genuinely returns
      // stale state if subscribe() delivers a newer write while read is in flight.
      const snapshot = state;
      onReadStarted?.();
      if (readDelay) await readDelay;
      if (failRead) throw new Error("read failure");
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed++;
      };
    },
  };

  return {
    handle,
    emit(next: StallRecoverySettingsState) {
      state = next;
      for (const listener of [...listeners]) void listener(next);
    },
    setReadDelay(p: Promise<void>) {
      readDelay = p;
    },
    waitReadStarted() {
      return new Promise<void>((resolve) => {
        onReadStarted = resolve;
      });
    },
    setFailRead(flag: boolean) {
      failRead = flag;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test("settings schema defaults to disabled, 300s timeout, and 3 retries", () => {
  assert.equal(stallRecoverySettings.id, "stall-recovery");
  assert.equal(stallRecoverySettings.scope, "host");
  assert.equal(stallRecoverySettings.version, 1);

  const parsed = stallRecoverySettingsSchema.parse({});
  assert.deepEqual(parsed, {
    enabled: false,
    stallTimeoutSeconds: 300,
    maxContinuations: 3,
  });
  assert.deepEqual(parsed, STALL_RECOVERY_DEFAULTS);

  assert.deepEqual(
    stallRecoverySettingsSchema.parse({
      enabled: true,
      stallTimeoutSeconds: STALL_TIMEOUT_SECONDS_MIN,
      maxContinuations: MAX_CONTINUATIONS_MIN,
    }),
    { enabled: true, stallTimeoutSeconds: 10, maxContinuations: 0 },
  );
  assert.deepEqual(
    stallRecoverySettingsSchema.parse({
      enabled: true,
      stallTimeoutSeconds: STALL_TIMEOUT_SECONDS_MAX,
      maxContinuations: MAX_CONTINUATIONS_MAX,
    }),
    { enabled: true, stallTimeoutSeconds: 3600, maxContinuations: 10 },
  );

  for (const invalid of [
    { enabled: "yes" },
    { stallTimeoutSeconds: 9 },
    { stallTimeoutSeconds: 3601 },
    { stallTimeoutSeconds: 150.5 },
    { maxContinuations: -1 },
    { maxContinuations: 11 },
    { maxContinuations: 1.5 },
  ]) {
    assert.throws(() => stallRecoverySettingsSchema.parse(invalid));
  }
});

test("strict integer parsers validate timeout and retries inputs cleanly", () => {
  assert.deepEqual(parseStallTimeoutSeconds("150"), { ok: true, value: 150 });
  assert.deepEqual(parseStallTimeoutSeconds(" 300 "), { ok: true, value: 300 });
  assert.deepEqual(parseStallTimeoutSeconds("10"), { ok: true, value: 10 });
  assert.deepEqual(parseStallTimeoutSeconds("3600"), { ok: true, value: 3600 });
  assert.deepEqual(parseStallTimeoutSeconds(""), { ok: false, reason: "required" });
  assert.deepEqual(parseStallTimeoutSeconds("   "), { ok: false, reason: "required" });
  assert.deepEqual(parseStallTimeoutSeconds("150.5"), { ok: false, reason: "integer" });
  assert.deepEqual(parseStallTimeoutSeconds("1e2"), { ok: false, reason: "integer" });
  assert.deepEqual(parseStallTimeoutSeconds("150s"), { ok: false, reason: "integer" });
  assert.deepEqual(parseStallTimeoutSeconds("9"), { ok: false, reason: "range" });
  assert.deepEqual(parseStallTimeoutSeconds("3601"), { ok: false, reason: "range" });

  assert.deepEqual(parseMaxContinuations("0"), { ok: true, value: 0 });
  assert.deepEqual(parseMaxContinuations("3"), { ok: true, value: 3 });
  assert.deepEqual(parseMaxContinuations("10"), { ok: true, value: 10 });
  assert.deepEqual(parseMaxContinuations(""), { ok: false, reason: "required" });
  assert.deepEqual(parseMaxContinuations("2.5"), { ok: false, reason: "integer" });
  assert.deepEqual(parseMaxContinuations("-1"), { ok: false, reason: "range" });
  assert.deepEqual(parseMaxContinuations("11"), { ok: false, reason: "range" });
});

test("settings store loads persisted values, notifies changes, and guards read/subscribe race", async () => {
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const mock = createMockSettingsHandle({
    status: "ready",
    revision: "rev-old",
    values: { enabled: true, stallTimeoutSeconds: 200, maxContinuations: 2 },
  });
  mock.setReadDelay(readGate);
  const readStarted = mock.waitReadStarted();

  const store = createRecoverySettingsStore(mock.handle);
  const seen: StallRecoverySettings[] = [];
  const off = store.onChange((next) => seen.push(next));

  // Wait until handle.read() has actually started and captured the stale rev-old snapshot.
  await readStarted;

  // Subscription delivers a newer write before initial read resolves.
  mock.emit({
    status: "ready",
    revision: "rev-new",
    values: { enabled: true, stallTimeoutSeconds: 400, maxContinuations: 5 },
  });
  releaseRead();
  const ready = await store.ready();

  assert.deepEqual(ready, { enabled: true, stallTimeoutSeconds: 400, maxContinuations: 5 });
  assert.deepEqual(store.get(), { enabled: true, stallTimeoutSeconds: 400, maxContinuations: 5 });
  assert.equal(seen.length, 1);

  // Duplicate identical update does not trigger extra notifications.
  mock.emit({
    status: "ready",
    revision: "rev-dup",
    values: { enabled: true, stallTimeoutSeconds: 400, maxContinuations: 5 },
  });
  assert.equal(seen.length, 1);

  off();
  store.dispose();
  assert.equal(mock.unsubscribed, 1);
});

test("settings store falls back safely to defaults on invalid state or read errors", async () => {
  const invalidMock = createMockSettingsHandle({
    status: "invalid",
    revision: "rev-bad",
    error: "corrupted json",
  });
  const s1 = createRecoverySettingsStore(invalidMock.handle);
  assert.deepEqual(await s1.ready(), STALL_RECOVERY_DEFAULTS);
  s1.dispose();

  const errorMock = createMockSettingsHandle({
    status: "ready",
    revision: "rev-1",
    values: { enabled: true, stallTimeoutSeconds: 120, maxContinuations: 4 },
  });
  errorMock.setFailRead(true);
  const s2 = createRecoverySettingsStore(errorMock.handle);
  assert.deepEqual(await s2.ready(), STALL_RECOVERY_DEFAULTS);
  s2.dispose();
});

test("Watch respects dynamic stallConfig: disabled never stalls, mid-turn enable starts a fresh window", () => {
  let cfg = { enabled: false, stallMs: 150 };
  const w = new Watch({ startup: 1_000_000, cancel: 50, stall: 150 }, () => cfg);
  w.startTurn("turn", 0);
  w.observe("out", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s" } } as AcpStreamMessage, 0);

  // Silent far past 150ms while disabled: never stalls.
  assert.deepEqual(w.check(500), {});
  assert.deepEqual(w.check(10_000), {});

  // Enable mid-turn at t=10_000: must wait a full fresh 150ms window, never instant-kill.
  cfg = { enabled: true, stallMs: 150 };
  w.syncRecovery(10_000);
  assert.deepEqual(w.check(10_050), {});
  assert.deepEqual(w.check(10_149), {});

  // Increase threshold to 300ms before triggering: waits until 10_300.
  cfg = { enabled: true, stallMs: 300 };
  assert.deepEqual(w.check(10_150), {});
  assert.deepEqual(w.check(10_299), {});

  // Toggle off and immediately back on at t=10_299: quiet clock resets cleanly.
  cfg = { enabled: false, stallMs: 300 };
  w.syncRecovery(10_299);
  cfg = { enabled: true, stallMs: 300 };
  w.syncRecovery(10_299);
  assert.deepEqual(w.check(10_598), {});
  assert.deepEqual(w.check(10_599), { stall: "turn" });
});

test("Recovery dynamic config stops pending backoff immediately when disabled or limit lowered", async (t) => {
  t.mock.method(console, "log", () => {});
  let cfg: RecoveryConfig = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
  const sent: ProviderInput[] = [];
  const events: ProviderEvent[] = [];
  const turnStates = new Map<string, { resumed: boolean; progress: boolean }>();
  const transport = {
    usable: true,
    watch: {
      canContinue: () => true,
      suspendRecovery() {},
      clearStallReported() {},
      turnProgress: (turnId: string) => turnStates.get(turnId) ?? { resumed: false, progress: false },
    },
  } as unknown as OwnedTransport;

  const recovery = new Recovery(
    {
      transport: () => transport,
      pending: () => false,
      send: async (input) => {
        sent.push(input);
      },
      emit: (e) => events.push(e),
    },
    150_000,
    { backoffBaseMs: 80, getConfig: () => cfg },
  );
  t.after(() => recovery.close());

  const startUserTurn = (id: string) => {
    turnStates.set(id, { resumed: false, progress: false });
    recovery.userInput({
      type: "session.prompt",
      sessionId: "s",
      prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content: [] } },
    });
    recovery.event({ type: "session.prompt_result", sessionId: "s", clientMessageId: id, result: { type: "turn", turnId: id } });
    recovery.event({ type: "session.turn", sessionId: "s", turnId: id, state: "started" });
  };

  // When disabled, stall() is a complete no-op.
  cfg = { enabled: false, stallMs: 150_000, maxContinuations: 3 };
  startUserTurn("t0");
  recovery.stall("s", "t0");
  assert.equal(sent.length, 0);

  // 1) Disable mid-backoff -> clears timer immediately and emits stopped notice.
  cfg = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
  recovery.stall("s", "t0");
  assert.equal(sent.length, 1);
  const cancelReq = sent[0]!;
  assert.equal(cancelReq.type, "session.interrupt");
  recovery.event({ type: "request.completed", requestId: cancelReq.requestId });
  recovery.event({ type: "session.turn", sessionId: "s", turnId: "t0", state: "canceled" }, "cancelled");

  await sleep(15);
  cfg = { enabled: false, stallMs: 150_000, maxContinuations: 3 };
  recovery.onConfigChange();
  await sleep(100);

  assert.equal(sent.filter((i) => i.type === "session.prompt").length, 0);
  const disabledNotice = events.find((e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
  assert.ok(disabledNotice?.type === "session.notice" && /auto-recovery disabled/i.test(disabledNotice.notice.title));

  // 2) Lower maxContinuations mid-backoff (to 0) -> clears timer immediately and stops.
  const eventsBeforeLower = events.length;
  cfg = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
  startUserTurn("t1");
  recovery.stall("s", "t1");
  const cancelReq2 = sent[sent.length - 1]!;
  assert.equal(cancelReq2.type, "session.interrupt");
  recovery.event({ type: "request.completed", requestId: cancelReq2.requestId });
  recovery.event({ type: "session.turn", sessionId: "s", turnId: "t1", state: "canceled" }, "cancelled");
  await sleep(15);
  cfg = { enabled: true, stallMs: 150_000, maxContinuations: 0 };
  recovery.onConfigChange();
  await sleep(100);
  assert.equal(sent.filter((i) => i.type === "session.prompt").length, 0);
  const loweredToZero = events.slice(eventsBeforeLower).find((e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
  assert.ok(loweredToZero?.type === "session.notice" && /automatic continuation disabled/i.test(loweredToZero.notice.title));

  // 3) Lower maxContinuations below/equal to attempts mid-backoff after 1st continuation -> exhausts immediately.
  const fastRecovery = new Recovery(
    {
      transport: () => transport,
      pending: () => false,
      send: async (input) => {
        sent.push(input);
      },
      emit: (e) => events.push(e),
    },
    150_000,
    { backoffBaseMs: 25, getConfig: () => cfg },
  );
  t.after(() => fastRecovery.close());
  cfg = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
  turnStates.set("t2", { resumed: false, progress: false });
  fastRecovery.userInput({
    type: "session.prompt",
    sessionId: "s",
    prompt: { clientMessageId: "t2", delivery: "auto", input: { type: "message", content: [] } },
  });
  fastRecovery.event({ type: "session.prompt_result", sessionId: "s", clientMessageId: "t2", result: { type: "turn", turnId: "t2" } });
  fastRecovery.event({ type: "session.turn", sessionId: "s", turnId: "t2", state: "started" });
  fastRecovery.stall("s", "t2");
  const c1Cancel = sent[sent.length - 1]!;
  assert.equal(c1Cancel.type, "session.interrupt");
  fastRecovery.event({ type: "request.completed", requestId: c1Cancel.requestId });
  fastRecovery.event({ type: "session.turn", sessionId: "s", turnId: "t2", state: "canceled" }, "cancelled");
  await sleep(45);
  const promptsAfterFirst = sent.filter((i) => i.type === "session.prompt");
  assert.equal(promptsAfterFirst.length, 1);
  const firstCont = promptsAfterFirst[0]!;
  assert.equal(firstCont.type, "session.prompt");
  turnStates.set("c1", { resumed: true, progress: true });
  assert.equal(
    fastRecovery.event({
      type: "session.prompt_result",
      sessionId: "s",
      clientMessageId: firstCont.prompt.clientMessageId,
      result: { type: "turn", turnId: "c1" },
    }),
    true,
  );
  fastRecovery.event({ type: "session.turn", sessionId: "s", turnId: "c1", state: "started" });
  fastRecovery.event({
    type: "timeline.item",
    sessionId: "s",
    item: { type: "assistant_message", id: "a1", text: "progress" },
  });

  // Second stall enters 50ms backoff (2nd attempt), then lower maxContinuations to 1.
  const eventsBeforeExhaust = events.length;
  fastRecovery.stall("s", "c1");
  const c2Cancel = sent[sent.length - 1]!;
  assert.equal(c2Cancel.type, "session.interrupt");
  fastRecovery.event({ type: "request.completed", requestId: c2Cancel.requestId });
  fastRecovery.event({ type: "session.turn", sessionId: "s", turnId: "c1", state: "canceled" }, "cancelled");
  await sleep(10);
  cfg = { enabled: true, stallMs: 150_000, maxContinuations: 1 };
  fastRecovery.onConfigChange();
  await sleep(80);
  assert.equal(sent.filter((i) => i.type === "session.prompt").length, 1, "must not send 2nd continuation after lowering limit to 1");
  const exhausted = events.slice(eventsBeforeExhaust).find((e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
  assert.ok(exhausted?.type === "session.notice" && /1\/1/.test(exhausted.notice.title));
});

for (const reenable of [false, true])
for (const terminalFirst of [false, true])
  test(`disabling while cancel is in-flight irreversibly fences continuation (reenable=${reenable}, terminalFirst=${terminalFirst})`, async (t) => {
    t.mock.method(console, "log", () => {});
    let cfg: RecoveryConfig = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
    const sent: ProviderInput[] = [];
    const events: ProviderEvent[] = [];
    const transport = {
      usable: true,
      watch: {
        canContinue: () => true,
        suspendRecovery() {},
        clearStallReported() {},
        turnProgress: () => ({ resumed: false, progress: false }),
      },
    } as unknown as OwnedTransport;

    const recovery = new Recovery(
      {
        transport: () => transport,
        pending: () => false,
        send: async (input) => {
          sent.push(input);
        },
        emit: (e) => events.push(e),
      },
      150_000,
      { backoffBaseMs: 0, getConfig: () => cfg },
    );
    t.after(() => recovery.close());

    recovery.userInput({
      type: "session.prompt",
      sessionId: "s",
      prompt: { clientMessageId: "u1", delivery: "auto", input: { type: "message", content: [] } },
    });
    recovery.event({ type: "session.prompt_result", sessionId: "s", clientMessageId: "u1", result: { type: "turn", turnId: "t1" } });
    recovery.event({ type: "session.turn", sessionId: "s", turnId: "t1", state: "started" });

    // Stall dispatches session.interrupt; cancel is now in-flight.
    recovery.stall("s", "t1");
    assert.equal(sent.length, 1);
    const cancelReq = sent[0]!;
    assert.equal(cancelReq.type, "session.interrupt");

    // Turn switch off while cancel is in-flight, and optionally turn back on before settle.
    cfg = { enabled: false, stallMs: 150_000, maxContinuations: 3 };
    recovery.onConfigChange();
    if (reenable) {
      cfg = { enabled: true, stallMs: 150_000, maxContinuations: 3 };
      recovery.onConfigChange();
    }

    // Settle cancel in either arrival order; internal ack must still be consumed.
    if (terminalFirst) {
      assert.equal(
        recovery.event({ type: "session.turn", sessionId: "s", turnId: "t1", state: "canceled" }, "cancelled"),
        false,
      );
      assert.equal(recovery.event({ type: "request.completed", requestId: cancelReq.requestId }), true);
    } else {
      assert.equal(recovery.event({ type: "request.completed", requestId: cancelReq.requestId }), true);
      assert.equal(
        recovery.event({ type: "session.turn", sessionId: "s", turnId: "t1", state: "canceled" }, "cancelled"),
        false,
      );
    }

    await sleep(30);
    assert.equal(
      sent.filter((i) => i.type === "session.prompt").length,
      0,
      "old canceled turn must never resurrect continuation after disable",
    );
    const stopped = events.find((e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
    assert.ok(stopped?.type === "session.notice" && /auto-recovery disabled/i.test(stopped.notice.title));
  });

test("provider defaults to stall recovery disabled unless enabled in settings", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agy-default-off-"));
  const traceFile = join(dir, "trace");
  const pidFile = join(dir, "pid");
  t.mock.method(console, "log", () => {});

  const c = await provider({
    checkVersion: async () => "1.5.18",
    limits: { startup: 3000, cancel: 500, stall: 120, quietDiag: 100 },
    closeTimeoutMs: 100,
  }).connect({
    versions: [1],
    capabilities: ["prompt.message", "permission", "session.persistence"],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./stall-fixture.mjs", import.meta.url))],
      env: { STALL_SCENARIO: "recover", TRACE_FILE: traceFile, PID_FILE: pidFile },
    },
  });
  const events: ProviderEvent[] = [];
  c.onEvent((e) => events.push(e));
  t.after(async () => {
    await c.close();
    await rm(dir, { recursive: true, force: true });
  });

  await c.send({
    type: "session.open",
    sessionId: "s",
    requestId: "open",
    history: "skip",
    config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  for (let i = 0; i < 200 && !events.some((e) => e.type === "session.ready"); i++) await sleep(10);

  await c.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: "u1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "LONG_EXTRA_HIGH_TASK" }] },
    },
  });
  await sleep(450);

  const trace = (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string });
  assert.deepEqual(trace.map((r) => r.method), ["session/prompt"]);
  assert.ok(!events.some((e) => e.type === "session.notice" && e.notice.id.startsWith("antigravity-recovery-")));
});

test("provider applies live host settings: toggle on, custom timeout and retry count", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agy-live-settings-"));
  const traceFile = join(dir, "trace");
  const pidFile = join(dir, "pid");
  t.mock.method(console, "log", () => {});

  const mockSettings = createMockSettingsHandle({
    status: "ready",
    revision: "rev-1",
    values: { enabled: false, stallTimeoutSeconds: 150, maxContinuations: 1 },
  });

  const c = await provider({
    checkVersion: async () => "1.5.18",
    limits: { startup: 3000, cancel: 500, stall: 150, quietDiag: 100 },
    recovery: { backoffBaseMs: 0 },
    settings: mockSettings.handle,
    // Scale seconds 1:1 to ms so real SDK integration tests run in < 1s.
    stallMsFromSeconds: (seconds) => seconds,
    closeTimeoutMs: 100,
  }).connect({
    versions: [1],
    capabilities: ["prompt.message", "permission", "session.persistence"],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./stall-fixture.mjs", import.meta.url))],
      env: { STALL_SCENARIO: "progress-exhaust", TRACE_FILE: traceFile, PID_FILE: pidFile },
    },
  });
  const events: ProviderEvent[] = [];
  c.onEvent((e) => events.push(e));
  t.after(async () => {
    await c.close();
    await rm(dir, { recursive: true, force: true });
  });

  await c.send({
    type: "session.open",
    sessionId: "s",
    requestId: "open",
    history: "skip",
    config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  for (let i = 0; i < 200 && !events.some((e) => e.type === "session.ready"); i++) await sleep(10);

  // Starts disabled -> silent turn past 150ms must NOT cancel.
  await c.send({
    type: "session.prompt",
    sessionId: "s",
    prompt: {
      clientMessageId: "u1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "EXTRA_HIGH" }] },
    },
  });
  await sleep(300);
  assert.ok(!events.some((e) => e.type === "session.notice" && e.notice.id.startsWith("antigravity-recovery-")));

  // Enable live with custom timeout (120ms scaled) and maxContinuations = 2.
  mockSettings.emit({
    status: "ready",
    revision: "rev-2",
    values: { enabled: true, stallTimeoutSeconds: 120, maxContinuations: 2 },
  });

  for (
    let i = 0;
    i < 400 &&
    !events.some((e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
    i++
  ) {
    await sleep(10);
  }

  const stopped = events.find(
    (e) => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped",
  );
  assert.ok(stopped?.type === "session.notice" && /2\/2/.test(stopped.notice.title));

  const trace = (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; text?: string });
  // 1 original + 2 continuations = 3 prompts; 3 cancels total (exhausted at 2/2).
  assert.equal(trace.filter((r) => r.method === "session/prompt").length, 3);
  assert.equal(trace.filter((r) => r.method === "session/cancel").length, 3);
  assert.ok(trace.some((r) => r.text?.includes("over 0.12s")));
});
