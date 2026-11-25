import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

const make = () => new Watch({ startup: 90, cancel: 5 });
const frame = (w: Watch, direction: "in" | "out", message: object, at: number) =>
  w.observe(direction, { jsonrpc: "2.0", ...message } as AcpStreamMessage, at);
const approval = (w: Watch, id: string, at: number, sessionId = "s") =>
  frame(w, "in", { id, method: "session/request_permission", params: { sessionId } }, at);
const stop = (w: Watch, at: number, sessionId = "s") =>
  frame(w, "out", { method: "session/cancel", params: { sessionId } }, at);
const answer = (w: Watch, id: string, at: number) =>
  frame(w, "out", { id, result: { outcome: { outcome: "cancelled" } } }, at);

test("restored approval without active prompt has a bounded Stop", () => {
  const w = make();
  frame(w, "out", { id: 1, method: "session/load", params: { sessionId: "s" } }, 0);
  approval(w, "p", 1);
  frame(w, "in", { id: 1, result: {} }, 2);
  assert.deepEqual(w.check(1000), {});
  stop(w, 1001);
  assert.deepEqual(w.check(1005), {});
  assert.match(w.check(1006).failure!, /取消/);
});

test("repeated Stop preserves old approval deadline and snapshots new requests", () => {
  const w = make();
  approval(w, "old", 0);
  stop(w, 1);
  approval(w, "new", 2);
  stop(w, 4);
  assert.match(w.check(6).failure!, /取消/);
  answer(w, "old", 6);
  assert.deepEqual(w.check(8), {});
  assert.match(w.check(9).failure!, /取消/);
});

test("answer clears only its target, later approvals do not inherit Stop", () => {
  const w = make();
  approval(w, "old", 0);
  stop(w, 1);
  approval(w, "later", 2);
  answer(w, "old", 3);
  assert.deepEqual(w.check(1000), {});
  stop(w, 1001);
  assert.match(w.check(1006).failure!, /取消/);
});

test("prompt completion cannot clear an unanswered approval cancellation", () => {
  const w = make();
  frame(w, "out", { id: 1, method: "session/prompt", params: { sessionId: "s" } }, 0);
  approval(w, "p", 1);
  stop(w, 2);
  frame(w, "in", { id: 1, result: { stopReason: "end_turn" } }, 3);
  assert.match(w.check(7).failure!, /取消/);
  answer(w, "p", 8);
  assert.deepEqual(w.check(1000), {});
});

test("approval cancellation is session scoped", () => {
  const w = make();
  approval(w, "other", 0, "other");
  stop(w, 1);
  assert.deepEqual(w.check(1000), {});
  approval(w, "ours", 1001);
  stop(w, 1002);
  answer(w, "other", 1003);
  assert.match(w.check(1007).failure!, /取消/);
});

test("resume rebases old approval deadlines but preserves fresh Stop", () => {
  const old = make();
  approval(old, "p", 0);
  stop(old, 1);
  old.resume(10000, 2);
  assert.deepEqual(old.check(10004), {});
  assert.match(old.check(10005).failure!, /取消/);
  const fresh = make();
  approval(fresh, "p", 0);
  stop(fresh, 9999);
  fresh.resume(10000, 2);
  assert.match(fresh.check(10004).failure!, /取消/);
});

test("clock rollback rebases approval cancellation", () => {
  const w = make();
  approval(w, "p", 10000);
  stop(w, 10001);
  w.resume(100, 10002);
  assert.deepEqual(w.check(104), {});
  assert.match(w.check(105).failure!, /取消/);
});
