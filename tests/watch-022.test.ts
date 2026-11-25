import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
const limits = { startup: 90000, cancel: 5000 };
function prompt(w: Watch, id: number, at: number) {
  w.observe(
    "out",
    {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId: "s" },
    },
    at,
  );
}
function cancel(w: Watch, at: number) {
  w.observe(
    "out",
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    at,
  );
}
function reply(w: Watch, id: number, at: number) {
  w.observe(
    "in",
    { jsonrpc: "2.0", id, result: { stopReason: "cancelled" } },
    at,
  );
}
function tool(w: Watch, id: string, at: number) {
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          status: "in_progress",
          rawInput: {},
        },
      },
    },
    at,
  );
}
test("canceled old tool ending cannot target a later tool or prompt", () => {
  const w = new Watch(limits);
  prompt(w, 1, 0);
  tool(w, "old", 1);
  cancel(w, 2000);
  prompt(w, 2, 3000);
  tool(w, "new", 3500);
  reply(w, 1, 4000);
  w.finishTool("old");
  assert.equal(w.check(7000).failure, undefined);
  assert.equal(w.check(1000000).failure, undefined);
});
test("prompt reply alone cannot discharge a canceled tool target", () => {
  const w = new Watch(limits);
  prompt(w, 1, 0);
  tool(w, "1", 1);
  cancel(w, 2000);
  reply(w, 1, 4000);
  assert.ok(w.check(7000).failure);
  w.finishTool("1");
  assert.equal(w.check(7001).failure, undefined);
});
test("post-rollback fresh cancellation preserves its deadline", () => {
  const w = new Watch(limits);
  prompt(w, 1, 10000);
  cancel(w, 999);
  w.resume(1000, 12000);
  assert.ok(w.check(5999).failure);
});
test("old canceled request completing releases deadline despite a new pending prompt", () => {
  const w = new Watch(limits);
  prompt(w, 1, 0);
  cancel(w, 2000);
  prompt(w, 2, 3000);
  reply(w, 1, 4000);
  assert.equal(w.check(7000).failure, undefined);
});
test("newer cancellation target receives its own deadline", () => {
  const w = new Watch(limits);
  prompt(w, 1, 0);
  cancel(w, 1000);
  prompt(w, 2, 3000);
  cancel(w, 4000);
  reply(w, 1, 5000);
  assert.equal(w.check(6000).failure, undefined);
  assert.ok(w.check(9000).failure);
});
test("repeated cancel does not keep postponing the old target deadline", () => {
  const w = new Watch(limits);
  prompt(w, 1, 0);
  cancel(w, 1000);
  cancel(w, 5000);
  assert.ok(w.check(6000).failure);
});
test("sleep includes work started between last tick and actual suspension", () => {
  const w = new Watch(limits);
  prompt(w, 1, 400);
  cancel(w, 450);
  w.resume(1000000, 0);
  assert.equal(w.check(1000001).failure, undefined);
  assert.ok(w.check(1005000).failure);
});
test("backward clock jump rebases deadlines without losing them", () => {
  const w = new Watch(limits);
  prompt(w, 1, 10000);
  cancel(w, 11000);
  w.resume(1000, 12000);
  assert.equal(w.check(1001).failure, undefined);
  assert.ok(w.check(6000).failure);
});
