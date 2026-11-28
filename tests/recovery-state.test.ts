import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { OwnedTransport } from "../server/transport.ts";
import { Recovery, recoveryDefaults, type RecoveryOptions } from "../server/recovery.ts";

function setup(t: test.TestContext, options: RecoveryOptions = {backoffBaseMs: 0}) {
  const log = t.mock.method(console, "log", () => {});
  const sent: ProviderInput[] = [], events: ProviderEvent[] = [];
  let usable = true, safe = true, pending = false, reject = false;
  const turnStates = new Map<string, {resumed: boolean; progress: boolean}>();
  const transport = {get usable() {return usable;}, watch: {
    canContinue: () => safe,
    suspendRecovery() {},
    turnProgress: (turnId: string) => turnStates.get(turnId) ?? {resumed: false, progress: false},
  }} as unknown as OwnedTransport;
  const recovery = new Recovery({transport: () => transport, pending: () => pending,
    emit: e => events.push(e), send: async input => {sent.push(input); if (reject) throw Error("PRIVATE_ERROR");},
  }, 150_000, options);
  const start = (id = "user", sessionId = "s") => {
    turnStates.set(id, {resumed: false, progress: false});
    recovery.userInput({type: "session.prompt", sessionId, prompt: {clientMessageId: id, delivery: "auto", input: {type: "message", content: []}}});
    recovery.event({type: "session.prompt_result", sessionId, clientMessageId: id, result: {type: "turn", turnId: id}});
    recovery.event({type: "session.turn", sessionId, turnId: id, state: "started"});
  };
  const stall = (turnId = "user") => {
    const before = sent.length;
    recovery.stall("s", turnId);
    const input = sent.slice(before).find(i => i.type === "session.interrupt");
    assert.ok(input?.type === "session.interrupt");
    return input.requestId;
  };
  const end = (reason = "cancelled", turnId = "user") =>
    recovery.event({type: "session.turn", sessionId: "s", turnId, state: "canceled"}, reason);
  const ack = (requestId: string) => recovery.event({type: "request.completed", requestId});
  const bindContinuation = (turnId: string) => {
    turnStates.set(turnId, {resumed: false, progress: false});
    const prompt = [...sent].reverse().find(i => i.type === "session.prompt");
    assert.ok(prompt?.type === "session.prompt");
    assert.equal(recovery.event({type: "session.prompt_result", sessionId: "s",
      clientMessageId: prompt.prompt.clientMessageId, result: {type: "turn", turnId}}), true);
    recovery.event({type: "session.turn", sessionId: "s", turnId, state: "started"});
  };
  const wire = (turnId: string, state: Partial<{resumed: boolean; progress: boolean}>) => {
    const cur = turnStates.get(turnId) ?? {resumed: false, progress: false};
    turnStates.set(turnId, {resumed: state.resumed ?? cur.resumed, progress: state.progress ?? cur.progress});
  };
  t.after(() => recovery.close());
  return {recovery, sent, events, log, start, stall, end, ack, bindContinuation, wire,
    set: (state: {usable?: boolean; safe?: boolean; pending?: boolean; reject?: boolean}) => {
      usable = state.usable ?? usable; safe = state.safe ?? safe;
      pending = state.pending ?? pending; reject = state.reject ?? reject;
    }};
}
test("defaults are max 3 continuations and 2000ms base backoff; invalid options rejected", () => {
  assert.equal(recoveryDefaults.maxContinuations, 3);
  assert.equal(recoveryDefaults.backoffBaseMs, 2_000);
  const ports = {transport: () => undefined, pending: () => false, send: async () => {}, emit: () => {}};
  for (const bad of [{maxContinuations: -1}, {maxContinuations: 1.5}, {backoffBaseMs: -1}, {backoffBaseMs: Infinity}, {backoffBaseMs: NaN}])
    assert.throws(() => new Recovery(ports, 150_000, bad));
});
for (const terminalFirst of [false, true]) test(`requires BOTH interrupt delivery and canceled turn (${terminalFirst})`, async t => {
  const h = setup(t); h.start(); const id = h.stall();
  if (terminalFirst) h.end(); else h.ack(id);
  await sleep(10);
  assert.equal(h.sent.length, 1);
  if (terminalFirst) h.ack(id); else h.end();
  await sleep(10);
  assert.equal(h.sent.length, 2);
  // Duplicate terminal/ack/timer triggers cannot manufacture a second continuation.
  h.end(); h.ack(id); h.recovery.stall("s", "user");
  await sleep(10); assert.equal(h.sent.length, 2);
});
for (const barrier of ["stop", "message", "transport", "close", "background", "replacement"])
  test(`pending continuation is fenced by ${barrier}`, async t => {
    const h = setup(t); h.start(); const id = h.stall(); h.ack(id); h.end();
    if (barrier === "stop") h.recovery.userInput({type: "session.interrupt", sessionId: "s", requestId: "stop"});
    if (barrier === "message") h.start("next");
    if (barrier === "transport") h.set({usable: false});
    if (barrier === "close") h.recovery.close();
    if (barrier === "background") h.set({safe: false});
    if (barrier === "replacement") h.set({pending: true});
    await sleep(10);
    assert.equal(h.sent.length, 1);
  });
for (const failure of ["admission", "ack", "runtime", "reason"]) test(`cancel ${failure} failure cannot resume or log raw errors`, async t => {
  const h = setup(t); h.start();
  if (failure === "admission") h.set({reject: true});
  const id = h.stall();
  if (failure === "ack") h.recovery.event({type: "request.failed", requestId: id, error: {message: "PRIVATE_ERROR"}});
  if (failure === "runtime") h.recovery.event({type: "session.runtime_failed", sessionId: "s", error: {message: "PRIVATE_ERROR"}});
  h.ack(id); h.end(failure === "reason" ? "end_turn" : "cancelled");
  await sleep(10);
  assert.equal(h.sent.length, 1);
  assert.ok(!JSON.stringify(h.events).includes("PRIVATE_ERROR"));
});
test("unknown/autonomous turns, queued replacements and stale generations never auto-cancel", t => {
  const h = setup(t);
  h.recovery.stall("s", "unknown");
  h.start(); h.set({pending: true}); h.recovery.stall("s", "user");
  h.set({pending: false}); h.start("next"); h.recovery.stall("s", "user");
  assert.equal(h.sent.length, 0);
});
for (const action of ["none", "stop", "message", "runtime-failure"]) test(`internal continuation receipt is consumed after ${action}`, async t => {
  const h = setup(t); h.start(); const id = h.stall(); h.ack(id); h.end();
  await sleep(10);
  const input = h.sent.find(i => i.type === "session.prompt");
  assert.ok(input?.type === "session.prompt");
  if (action === "stop") h.recovery.userInput({type: "session.interrupt", sessionId: "s", requestId: "user-stop"});
  if (action === "message") h.start("next");
  if (action === "runtime-failure") h.recovery.event({type: "session.runtime_failed", sessionId: "s", error: {message: "fixture"}});
  const receipt: ProviderEvent = {type: "session.prompt_result", sessionId: "s",
    clientMessageId: input.prompt.clientMessageId, result: {type: "turn", turnId: "continuation-turn"}};
  assert.equal(h.recovery.event({...receipt, sessionId: "other"}), false);
  assert.equal(h.recovery.event(receipt), true);
  assert.equal(h.recovery.event({type: "session.turn", sessionId: "s", turnId: "continuation-turn", state: "started"}), false);
  if (action === "none") {
    h.recovery.stall("s", "continuation-turn");
    assert.equal(h.sent.length, 3, "internal receipt must bind the continued turn before being consumed");
  } else {
    h.recovery.stall("s", "continuation-turn");
    assert.equal(h.sent.length, 2, "late receipt must not resurrect invalidated recovery");
  }
});
for (const nonProgress of ["nothing", "reasoning-only", "blank-assistant", "running-tool", "stale-tool-echo"])
  test(`zero substantive progress circuit-breaks immediately (${nonProgress})`, async t => {
    const h = setup(t); h.start();
    const id1 = h.stall("user"); h.ack(id1); h.end("cancelled", "user"); await sleep(10);
    h.bindContinuation("c1");
    if (nonProgress === "reasoning-only") {
      h.wire("c1", {resumed: true, progress: false});
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "reasoning", id: "r1", text: "thinking..."}});
    } else if (nonProgress === "blank-assistant") {
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "assistant_message", id: "a1", text: "   "}});
    } else if (nonProgress === "running-tool") {
      h.wire("c1", {resumed: true, progress: false});
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "tool_call", id: "t1", callId: "t1", name: "read_file", detail: {type: "read", filePath: "/tmp/f"}, status: "running", error: null}});
    } else if (nonProgress === "stale-tool-echo") {
      // Watch rejects retired/prior-turn echoes, so turnProgress remains false even if SDK forwards a completed tool snapshot.
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "tool_call", id: "old", callId: "old", name: "run_command", detail: {type: "read", filePath: "/tmp/f"}, status: "completed", error: null}});
    }
    const id2 = h.stall("c1"); h.ack(id2); h.end("cancelled", "c1"); await sleep(10);
    assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 1, "must not attempt continuation 2/3 without substantive progress");
    const stopped = h.events.find(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
    assert.ok(stopped?.type === "session.notice" && /No substantive progress/i.test(stopped.notice.title));
    const phases = h.log.mock.calls.filter(c => c.arguments[0] === "[antigravity:recovery]").map(c => JSON.parse(c.arguments[1] as string).phase);
    assert.ok(phases.includes("no-progress"));
    const resumedNotices = h.events.filter(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-resumed");
    assert.equal(resumedNotices.length, ["reasoning-only", "running-tool"].includes(nonProgress) ? 1 : 0);
  });
for (const kind of ["assistant", "tool"]) test(`substantive ${kind} progress permits up to 3 continuations then stops`, async t => {
  const h = setup(t); h.start();
  let turnId = "user";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cid = h.stall(turnId); h.ack(cid); h.end("cancelled", turnId); await sleep(10);
    assert.equal(h.sent.filter(i => i.type === "session.prompt").length, attempt);
    turnId = `c${attempt}`;
    h.bindContinuation(turnId);
    // Emit multiple items to verify resumed notice fires only once per attempt.
    h.wire(turnId, {resumed: true, progress: false});
    h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "reasoning", id: `r${attempt}`, text: "step"}});
    h.wire(turnId, {resumed: true, progress: true});
    if (kind === "assistant")
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "assistant_message", id: `a${attempt}`, text: "done part"}});
    else
      h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "tool_call", id: `t${attempt}`, callId: `t${attempt}`, name: "edit_file", detail: {type: "read", filePath: "/tmp/f"}, status: "completed", error: null}});
  }
  // 4th stall exhausts 3/3 even after substantive progress.
  const finalCancel = h.stall(turnId); h.ack(finalCancel); h.end("cancelled", turnId); await sleep(10);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 3);
  assert.equal(h.events.filter(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-resumed").length, 3);
  const stopped = h.events.find(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
  assert.ok(stopped?.type === "session.notice" && /3\/3/.test(stopped.notice.title));
});
test("exponential backoff delays continuations and user Stop during backoff cancels cleanly", async t => {
  const h = setup(t, {backoffBaseMs: 40}); h.start();
  const t0 = Date.now();
  const id1 = h.stall("user"); h.ack(id1); h.end("cancelled", "user");
  await sleep(15);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 0, "must wait backoff before sending 1/3");
  await sleep(50);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 1);
  assert.ok(Date.now() - t0 >= 35);
  h.bindContinuation("c1");
  h.wire("c1", {resumed: true, progress: true});
  h.recovery.event({type: "timeline.item", sessionId: "s", item: {type: "tool_call", id: "t1", callId: "t1", name: "edit_file", detail: {type: "read", filePath: "/tmp/f"}, status: "completed", error: null}});
  const id2 = h.stall("c1"); h.ack(id2); h.end("cancelled", "c1");
  await sleep(35);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 1, "2nd backoff must be longer (80ms)");
  h.recovery.userInput({type: "session.interrupt", sessionId: "s", requestId: "user-stop"});
  await sleep(100);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 1, "user Stop during backoff must cancel continuation");
});
test("maxContinuations=0 cancels without continuing", async t => {
  const h = setup(t, {maxContinuations: 0, backoffBaseMs: 0}); h.start();
  const id = h.stall("user"); h.ack(id); h.end("cancelled", "user"); await sleep(10);
  assert.equal(h.sent.filter(i => i.type === "session.prompt").length, 0);
  assert.ok(h.events.some(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped"));
});
test("failed internal prompt receipt is consumed and reports only abnormal recovery notice", async t => {
  const h = setup(t); h.start(); const id = h.stall(); h.ack(id); h.end(); await sleep(10);
  const input = h.sent.find(i => i.type === "session.prompt"); assert.ok(input?.type === "session.prompt");
  assert.equal(h.recovery.event({type: "session.prompt_result", sessionId: "s",
    clientMessageId: input.prompt.clientMessageId, result: {type: "failed", error: {message: "PRIVATE_ERROR"}}}), true);
  assert.deepEqual(h.events.filter(e => e.type === "session.notice").map(e => e.notice.id),
    ["antigravity-recovery-cancel", "antigravity-recovery-continuing", "antigravity-recovery-aborted"]);
  assert.ok(!JSON.stringify(h.events).includes("PRIVATE_ERROR"));
});
test("a host-chosen continuation-looking ID is not an internal receipt", t => {
  const h = setup(t), id = "antigravity-continuation:user-chosen";
  h.start(id);
  assert.equal(h.recovery.event({type: "session.prompt_result", sessionId: "s", clientMessageId: id,
    result: {type: "turn", turnId: id}}), false);
});
test("Stop in another session does not consume the current session allowance", async t => {
  const h = setup(t); h.start(); const id = h.stall();
  h.recovery.userInput({type: "session.interrupt", sessionId: "other", requestId: "other-stop"});
  h.ack(id); h.end(); await sleep(10);
  assert.equal(h.sent.length, 2);
});
