import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
const limits = { startup: 90, cancel: 5 };
const out = (
  w: Watch,
  id: number,
  method = "session/prompt",
  sid = "s",
  at = 0,
) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", id, method, params: { sessionId: sid } },
    at,
  );
const response = (w: Watch, id: number, at = 1) =>
  w.observe(
    "in",
    { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } },
    at,
  );
const update = (
  w: Watch,
  id: string,
  status: string,
  at = 1,
  sid = "s",
  extra = {},
) =>
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          ...extra,
        },
      },
    },
    at,
  );
const cancel = (w: Watch, at = 0) =>
  w.observe(
    "out",
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    at,
  );

test("silent prompt has no automatic inactivity deadline", () => {
  const w = new Watch(limits);
  out(w, 1);
  for (const at of [30, 60, 149]) assert.deepEqual(w.check(at), {});
  assert.deepEqual(w.check(90000000), {});
  cancel(w, 90000001);
  assert.match(w.check(90000006).failure!, /取消/);
});
test("normal long tools are never killed for silence", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "a", "in_progress");
  for (const at of [31, 10000, 10001]) assert.deepEqual(w.check(at), {});
});
test("new post-response tool stays quiet and remains cancellable", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "a", "in_progress");
  response(w, 1, 2);
  update(w, "a", "completed", 3);
  update(w, "b", "in_progress", 4);
  assert.deepEqual(w.check(34), {});
  cancel(w, 35);
  assert.match(w.check(40).failure!, /取消/);
});
test("cancel stays armed until every overlapping prompt settles", () => {
  const w = new Watch(limits);
  out(w, 1);
  out(w, 2);
  cancel(w, 10);
  response(w, 2, 11);
  assert.match(w.check(15).failure!, /取消/);
});
test("confirmed cancellation disarms deadline", () => {
  const w = new Watch(limits);
  out(w, 1);
  cancel(w, 10);
  response(w, 1, 11);
  assert.equal(w.check(20).failure, undefined);
});
test("permission wait pauses silence but never pauses cancellation", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      id: "p",
      method: "session/request_permission",
      params: { sessionId: "s" },
    },
    1,
  );
  assert.equal(w.check(1000).failure, undefined);
  cancel(w, 1001);
  assert.match(w.check(1006).failure!, /取消/);
});
test("answered permission does not start a silence deadline", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      id: "p",
      method: "session/request_permission",
      params: { sessionId: "s" },
    },
    1,
  );
  w.observe("out", { jsonrpc: "2.0", id: "p", result: {} }, 1000);
  assert.equal(w.check(1001).failure, undefined);
  assert.deepEqual(w.check(90000000), {});
});
test("unrelated session activity does not affect a silent prompt", () => {
  const w = new Watch(limits);
  out(w, 1);
  update(w, "alien", "in_progress", 149, "other");
  assert.deepEqual(w.check(90000000), {});
});
// Native ACP notifications remain supported; no external quota query is involved.
test("ACP usage_update does not introduce a prompt inactivity deadline", () => {
  const w = new Watch(limits);
  out(w, 1);
  w.observe(
    "in",
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "usage_update" } },
    },
    149,
  );
  assert.deepEqual(w.check(90000000), {});
});
test("completed and detached tools do not imply background work has ended", () => {
  for (const detached of [false, true]) {
    const w = new Watch(limits);
    out(w, 1);
    update(
      w,
      "a",
      detached ? "in_progress" : "completed",
      1,
      "s",
      detached ? { rawInput: { IsDaemon: true } } : {},
    );
    assert.deepEqual(w.check(90000000), {});
  }
});
test("initialize and model selection also have deadlines", () => {
  for (const m of ["initialize", "session/set_config_option"]) {
    const w = new Watch(limits);
    out(w, 1, m);
    assert.ok(w.check(90).failure);
    response(w, 1, 91);
    assert.equal(w.check(200).failure, undefined);
  }
});
