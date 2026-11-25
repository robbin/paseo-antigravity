import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
const limits = { startup: 90, cancel: 5 };
const prompt = (w: Watch, id = 1, at = 0) =>
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
const response = (w: Watch, id = 1, stopReason = "end_turn", at = 1) =>
  w.observe("in", { jsonrpc: "2.0", id, result: { stopReason } }, at);
const cancel = (w: Watch, at = 2) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    at,
  );
const tool = (w: Watch, status = "in_progress", at = 1) =>
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "tool_call", toolCallId: "old", status },
      },
    },
    at,
  );
test("host sleep rebases old clocks but not new cancellation", () => {
  const w = new Watch(limits);
  prompt(w);
  w.resume(10000, 10);
  assert.equal(w.check(10001).failure, undefined);
  assert.deepEqual(w.check(10150), {});
  const next = new Watch(limits);
  prompt(next);
  cancel(next, 9999);
  next.resume(10000, 10);
  assert.ok(next.check(10004).failure);
});
test("SDK terminalization clears ghost tools and ignores their late echoes", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w);
  w.finishTool("old");
  tool(w, "in_progress", 4);
  assert.deepEqual(w.check(40), {});
  prompt(w, 2, 50);
  assert.deepEqual(w.check(201), {});
  cancel(w, 202);
  response(w, 2, "cancelled", 203);
  assert.deepEqual(w.check(207), {});
});
test("new steering prompt must not disarm an outstanding cancellation", () => {
  const w = new Watch(limits);
  prompt(w);
  cancel(w);
  prompt(w, 2, 3);
  response(w, 2, "end_turn", 4);
  assert.ok(w.check(7).failure);
});
test("idle cancel never arms deadline or poisons next prompt", () => {
  const w = new Watch(limits);
  prompt(w);
  response(w);
  cancel(w);
  assert.equal(w.check(7).failure, undefined);
  prompt(w, 2, 8);
  assert.equal(w.check(9).failure, undefined);
});
test("cancel deadline clears when post-response tools all finish", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w);
  cancel(w);
  tool(w, "completed", 3);
  assert.equal(w.check(7).failure, undefined);
});
test("load replay tools do not become cancellation targets", () => {
  const w = new Watch(limits);
  w.observe(
    "out",
    {
      jsonrpc: "2.0",
      id: 10,
      method: "session/load",
      params: { sessionId: "s" },
    },
    0,
  );
  tool(w);
  w.observe("in", { jsonrpc: "2.0", id: 10, result: {} }, 2);
  // History ends at the response; post-response tools would be live work.
  assert.deepEqual(w.check(40), {});
  prompt(w, 1, 50);
  assert.deepEqual(w.check(201), {});
  cancel(w, 202);
  response(w, 1, "cancelled", 203);
  assert.deepEqual(w.check(207), {});
});
test("SDK terminal event after cancellation clears ghost tools", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  response(w, 1, "cancelled", 2);
  w.finishTool("old"); // SDK terminalizeTransientItems emits the canceled tool.
  assert.deepEqual(w.check(40), {});
  prompt(w, 2, 50);
  assert.deepEqual(w.check(201), {});
  cancel(w, 202);
  response(w, 2, "cancelled", 203);
  assert.deepEqual(w.check(207), {});
});
test("SDK terminal event after RPC error clears ghost tools", () => {
  const w = new Watch(limits);
  prompt(w);
  tool(w);
  w.observe(
    "in",
    { jsonrpc: "2.0", id: 1, error: { code: -1, message: "fixture" } },
    2,
  );
  w.finishTool("old"); // Failed turn has an explicit SDK tool terminal event.
  prompt(w, 2, 50);
  assert.deepEqual(w.check(201), {});
  cancel(w, 202);
  response(w, 2, "cancelled", 203);
  assert.deepEqual(w.check(207), {});
});
test("no progress notices across silence intervals or subsequent turns", () => {
  const w = new Watch(limits);
  prompt(w);
  assert.deepEqual(w.check(30), {});
  tool(w, "in_progress", 31);
  for (const at of [62, 1000, 10000]) assert.deepEqual(w.check(at), {});
  tool(w, "completed", 10001);
  response(w, 1, "end_turn", 10002);
  for (const at of [10032, 20000]) assert.deepEqual(w.check(at), {});
  prompt(w, 2, 20001);
  assert.deepEqual(w.check(20031), {});
  assert.deepEqual(w.check(90000000), {});
});
