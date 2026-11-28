import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { OwnedTransport } from "../server/transport.ts";
import { Recovery } from "../server/recovery.ts";

function setup(t: test.TestContext) {
  t.mock.method(console, "log", () => {});
  const sent: ProviderInput[] = [], events: ProviderEvent[] = [];
  let usable = true, safe = true, pending = false, reject = false;
  const transport = {get usable() {return usable;}, watch: {
    canContinue: () => safe, suspendRecovery() {},
  }} as unknown as OwnedTransport;
  const recovery = new Recovery({transport: () => transport, pending: () => pending,
    emit: e => events.push(e), send: async input => {sent.push(input); if (reject) throw Error("PRIVATE_ERROR");},
  }, 150_000);
  const start = (id = "user", sessionId = "s") => {
    recovery.userInput({type: "session.prompt", sessionId, prompt: {clientMessageId: id, delivery: "auto", input: {type: "message", content: []}}});
    recovery.event({type: "session.prompt_result", sessionId, clientMessageId: id, result: {type: "turn", turnId: id}});
    recovery.event({type: "session.turn", sessionId, turnId: id, state: "started"});
  };
  const stall = () => {
    recovery.stall("s", "user");
    const input = sent.find(i => i.type === "session.interrupt");
    assert.ok(input?.type === "session.interrupt");
    return input.requestId;
  };
  const end = (reason = "cancelled") => recovery.event({type: "session.turn", sessionId: "s", turnId: "user", state: "canceled"}, reason);
  const ack = (requestId: string) => recovery.event({type: "request.completed", requestId});
  t.after(() => recovery.close());
  return {recovery, sent, events, start, stall, end, ack,
    set: (state: {usable?: boolean; safe?: boolean; pending?: boolean; reject?: boolean}) => {
      usable = state.usable ?? usable; safe = state.safe ?? safe;
      pending = state.pending ?? pending; reject = state.reject ?? reject;
    }};
}
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
