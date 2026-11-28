import test from "node:test";
import assert from "node:assert/strict";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { Watch, defaults } from "../server/watch.ts";
import { createTransport } from "../server/transport.ts";

function harness(stall = 150) {
  const w = new Watch({startup: 1_000_000, cancel: 50, stall});
  const frame = (direction: "in" | "out", message: object, at: number) =>
    w.observe(direction, {jsonrpc: "2.0", ...message} as AcpStreamMessage, at);
  const prompt = (at = 0, id = 1) => frame("out", {id, method: "session/prompt", params: {sessionId: "s"}}, at);
  const update = (update: object, at: number, sessionId = "s") =>
    frame("in", {method: "session/update", params: {sessionId, update}}, at);
  const tool = (extra: object, at: number, toolCallId = "tool") =>
    update({sessionUpdate: "tool_call_update", toolCallId, ...extra}, at);
  w.startTurn("turn", 0);
  prompt();
  return {w, frame, prompt, update, tool};
}

test("default is exactly 300 seconds; diagnostic threshold remains independent", () => {
  assert.equal(defaults.stall, 300_000);
  assert.equal(defaults.cancel, 5_000);
  const {w} = harness(defaults.stall);
  assert.deepEqual(w.check(299_999), {});
  assert.deepEqual(w.check(300_000), {stall: "turn"});
  assert.deepEqual(w.check(600_000), {}, "one trigger per SDK turn");
  // Mismatched turnId cannot clear the latch; matching turnId allows re-checking.
  w.clearStallReported("other-turn");
  assert.deepEqual(w.check(600_001), {});
  w.clearStallReported("turn");
  assert.deepEqual(w.check(600_002), {stall: "turn"});
});
for (const kind of ["agent_thought_chunk", "agent_message_chunk"]) {
  test(`continuous ${kind} resets inactivity, not total elapsed time`, () => {
    const {w, update} = harness();
    for (let at = 100; at <= 1000; at += 100) {
      update({sessionUpdate: kind, content: {type: "text", text: "PRIVATE"}}, at);
      assert.deepEqual(w.check(at + 99), {});
    }
    assert.deepEqual(w.check(1149), {});
    assert.deepEqual(w.check(1150), {stall: "turn"});
  });
}
test("foreground tool wait is excluded, synchronous completion starts a fresh window", () => {
  const {w, tool} = harness();
  tool({name: "run_command", status: "in_progress", rawInput: {CommandLine: "PRIVATE"}}, 10);
  assert.deepEqual(w.check(10000), {});
  tool({status: "completed", rawOutput: {exit_code: 0}}, 10001);
  assert.deepEqual(w.check(10150), {});
  assert.deepEqual(w.check(10151), {stall: "turn"});
});
test("approval wait is excluded and its answer starts a fresh window", () => {
  const {w, frame} = harness();
  frame("in", {id: "permission", method: "session/request_permission", params: {sessionId: "s"}}, 10);
  assert.deepEqual(w.check(10000), {});
  frame("out", {id: "permission", result: {}}, 10001);
  assert.deepEqual(w.check(10150), {});
  assert.deepEqual(w.check(10151), {stall: "turn"});
});
for (const name of ["run_command", "invoke_subagent", "schedule"]) test(`permission-only async input remains protected after approval: ${name}`, () => {
  const {w, frame, prompt} = harness();
  frame("in", {id: "permission", method: "session/request_permission", params: {sessionId: "s",
    toolCall: {toolCallId: "async", name, rawInput: name === "run_command" ? {IsDaemon: true} : {}}}}, 10);
  frame("out", {id: "permission", result: {outcome: {outcome: "selected", optionId: "allow"}}}, 20);
  assert.deepEqual(w.check(10000), {});
  frame("in", {id: 1, result: {stopReason: "end_turn"}}, 10001);
  w.endTurn("turn"); w.startTurn("next", 10002); prompt(10002, 2);
  assert.deepEqual(w.check(10152), name === "run_command" ? {} : {stall: "next"});
});
for (const extra of [
  {name: "run_command", rawInput: {IsDaemon: true}},
  {name: "run_command", rawOutput: "Tool is running as a background task"},
  {name: "run_command", rawOutput: {output: "task id: PRIVATE_TASK"}},
  {name: "run_command", content: [{type: "content", content: {type: "text", text: "task id: PRIVATE_TASK"}}]},
  {name: "invoke_subagent"},
  {title: "invoke_subagent"},
  {name: "schedule", rawInput: {CronExpression: "* * * * *"}},
  {name: "schedule", rawInput: {}},
  {name: "schedule", rawInput: {CronExpression: "   "}},
]) test(`background launch stays protected after completed/synthetic rows: ${JSON.stringify(extra)}`, () => {
  const {w, tool, frame, prompt} = harness();
  tool({status: "in_progress", ...extra}, 10);
  tool({status: "completed"}, 11);
  w.finishTool("tool", 12);
  assert.deepEqual(w.check(10000), {});
  frame("in", {id: 1, result: {stopReason: "end_turn"}}, 10001);
  w.endTurn("turn");
  assert.equal(w.canContinue(), false, "normal ending alone does not release before next turn");
  w.startTurn("next", 10002); prompt(10002, 2);
  tool({status: "completed", ...extra}, 10003); // late old launcher echo cannot rearm
  const input = (extra as {rawInput?: {IsDaemon?: boolean; CronExpression?: string}}).rawInput;
  const persistent = input?.IsDaemon === true || !!input?.CronExpression?.trim();
  assert.deepEqual(w.check(10151), {});
  assert.deepEqual(w.check(10152), persistent ? {} : {stall: "next"});
});
test("only explicit same-call command exit discharges background guard, even after retired row", () => {
  const {w, tool} = harness();
  tool({name: "run_command", status: "completed", rawOutput: "task id: PRIVATE"}, 10);
  tool({status: "completed", rawOutput: {exit_code: 0}}, 200, "other");
  assert.deepEqual(w.check(1000), {});
  tool({status: "completed", rawOutput: {exit_code: null}}, 1001);
  assert.deepEqual(w.check(2000), {});
  tool({status: "completed", rawOutput: {exit_code: 0}}, 2001);
  assert.deepEqual(w.check(2150), {});
  assert.deepEqual(w.check(2151), {stall: "turn"});
});
test("async launcher generic completion/failed/exit-shaped output is not job completion", () => {
  const {w, tool} = harness();
  tool({name: "invoke_subagent", status: "completed"}, 10);
  tool({status: "failed", rawOutput: {exit_code: 0}}, 20);
  assert.deepEqual(w.check(10000), {});
});
for (const extra of [
  {name: "run_command", rawOutput: "task id: historical"},
  {name: "invoke_subagent"},
  {name: "schedule"},
  {name: "run_command", rawInput: {IsDaemon: true}},
  {name: "schedule", rawInput: {CronExpression: "* * * * *"}},
]) test(`historical background evidence cannot block a new turn: ${JSON.stringify(extra)}`, () => {
  const {w, frame, tool, prompt} = harness();
  frame("in", {id: 1, result: {stopReason: "end_turn"}}, 1);
  w.endTurn("turn");
  frame("out", {id: 2, method: "session/load", params: {sessionId: "s"}}, 10);
  tool({status: "completed", ...extra}, 20);
  frame("in", {id: "approval", method: "session/request_permission", params: {sessionId: "s",
    toolCall: {toolCallId: "historical-approval", ...extra}}}, 21);
  frame("out", {id: "approval", result: {}}, 22);
  assert.deepEqual(w.check(10000), {});
  frame("in", {id: 2, result: {}}, 10001);
  w.startTurn("new", 10002); prompt(10002, 3);
  assert.deepEqual(w.check(10151), {});
  assert.deepEqual(w.check(10152), {stall: "new"});
});
for (const boundary of ["canceled", "failed", "replaced", "max_tokens", "wire-only"])
  test(`non-normal turn boundary never releases pending async work: ${boundary}`, () => {
    const {w, frame, prompt, tool} = harness();
    tool({name: "invoke_subagent", status: "completed"}, 10);
    frame("in", {id: 1, result: {stopReason: boundary === "canceled" ? "cancelled" :
      boundary === "max_tokens" ? "max_tokens" : "end_turn"}}, 20);
    if (boundary === "replaced") w.turn!.replaced = true;
    if (boundary !== "wire-only") w.endTurn("turn", boundary !== "failed");
    w.startTurn("next", 30); prompt(30, 2);
    assert.deepEqual(w.check(10000), {});
  });
for (const extra of [
  {name: "run_command", rawInput: {IsDaemon: true}},
  {name: "schedule", rawInput: {CronExpression: "* * * * *"}},
]) test(`live persistent scope survives partial updates, releases on explicit exit: ${extra.name}`, () => {
  const {w, tool, frame, prompt} = harness();
  tool({status: "completed", ...extra}, 10);
  tool({name: extra.name, status: "completed", rawInput: {}}, 11);
  frame("in", {id: 1, result: {stopReason: "end_turn"}}, 20);
  w.endTurn("turn"); w.startTurn("next", 30); prompt(30, 2);
  assert.deepEqual(w.check(10000), {});
  tool({...extra, status: "completed", rawOutput: {exit_code: 0}}, 10001);
  tool({status: "completed", ...extra}, 10002); // stale echo cannot resurrect exited job
  assert.deepEqual(w.check(10150), {});
  assert.deepEqual(w.check(10151), {stall: "next"});
});
test("overlapping prompts and SDK deferred/steered turns are excluded", () => {
  const {w, prompt, frame} = harness();
  prompt(1, 2);
  assert.deepEqual(w.check(10000), {});
  frame("in", {id: 1, result: {stopReason: "end_turn"}}, 10001);
  assert.deepEqual(w.check(20000), {});
});
test("user Stop/invalidation disarms inactivity independently of delivery", () => {
  const {w} = harness();
  const token = w.requestStop(100)!;
  assert.deepEqual(w.check(149), {});
  w.settleStop(token);
  assert.deepEqual(w.check(10000), {});
  const next = harness().w;
  next.suspendRecovery();
  assert.deepEqual(next.check(10000), {});
});
for (const backward of [false, true]) test(`sleep/clock jump rebases recovery (${backward})`, () => {
  const {w, update} = harness();
  update({sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "x"}}, 400);
  const now = backward ? 10 : 10000;
  w.resume(now, backward ? 450 : 350);
  assert.deepEqual(w.check(now + 149), {});
  assert.deepEqual(w.check(now + 150), {stall: "turn"});
});
test("wake preserves fresh post-wake activity window", () => {
  const {w, update} = harness();
  update({sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "x"}}, 9999);
  w.resume(10000, 100);
  assert.deepEqual(w.check(10149), {}); // eligibility clock rebased to wake, conservative
  assert.deepEqual(w.check(10150), {stall: "turn"});
});
for (const stall of [0, -1, Infinity, NaN]) test(`invalid stall limit rejected before spawn: ${stall}`, () => {
  assert.throws(() => createTransport({command: "/never-spawn", args: [], env: {}},
    {cwd: process.cwd(), env: {}}, () => {}, {startup: 100, cancel: 50, stall}), /positive/i);
});
for (const nonCommand of [
  {name: "read_file", kind: "read"},
  {name: "edit_file", kind: "edit"},
  {name: "write_file", kind: "edit"},
  {name: "search_web", kind: "search"},
  {name: "mcp_paseo_get_agent_activity", kind: "other"},
  {kind: "read"},
  {kind: "edit"},
  {kind: "search"},
]) test(`non-command tool quoting background prose never blocks recovery: ${JSON.stringify(nonCommand)}`, () => {
  const {w, tool} = harness();
  tool({status: "in_progress", ...nonCommand}, 10);
  // Follow-up update omits name/kind, mimicking partial ACP tool_call_update frames.
  tool({status: "completed", rawInput: {IsDaemon: true},
    rawOutput: "Tool is running as a background task; task id: DOCS_EXAMPLE"}, 11);
  // Retired non-background tool echo omitting name/kind must never manufacture a guard either.
  tool({status: "completed", rawOutput: "task id: LATE_ECHO"}, 12);
  assert.deepEqual(w.check(160), {});
  assert.deepEqual(w.check(161), {stall: "turn"});
});
test("unnamed execute tool with background prose still blocks recovery", () => {
  const {w, tool} = harness();
  tool({status: "completed", kind: "execute", rawOutput: "Tool is running as a background task; task id: EXEC_JOB"}, 10);
  assert.deepEqual(w.check(10000), {});
});
test("message ownership namespaces text vs thought and retains >2048 prior IDs without eviction", () => {
  const {w, frame, update, prompt} = harness();
  for (let i = 0; i < 2050; i++)
    update({sessionUpdate: "agent_message_chunk", messageId: `m-${i}`, content: {type: "text", text: "old"}}, i + 1);
  update({sessionUpdate: "agent_thought_chunk", messageId: "shared", content: {type: "text", text: "thought"}}, 2051);
  frame("in", {id: 1, result: {stopReason: "cancelled"}}, 2052);
  w.endTurn("turn", false);
  w.startTurn("c1", 2060); prompt(2060, 2);
  // Earliest ID beyond 2048 must still be recognized as belonging to the old turn.
  update({sessionUpdate: "agent_message_chunk", messageId: "m-0", content: {type: "text", text: "late"}}, 2061);
  assert.deepEqual(w.turnProgress("c1"), {resumed: false, progress: false});
  // Same messageId in a different chunk namespace (message vs thought) belongs to the new turn.
  update({sessionUpdate: "agent_message_chunk", messageId: "shared", content: {type: "text", text: "new reply"}}, 2062);
  assert.deepEqual(w.turnProgress("c1"), {resumed: true, progress: true});
});
test("retired tool tracking retains >2048 prior tool IDs without eviction", () => {
  const {w, frame, tool, prompt} = harness();
  for (let i = 0; i < 2050; i++)
    tool({name: "run_command", status: "completed", rawOutput: {exit_code: 0}}, i + 1, `old-tool-${i}`);
  frame("in", {id: 1, result: {stopReason: "cancelled"}}, 2051);
  w.endTurn("turn", false);
  w.startTurn("c1", 2060); prompt(2060, 2);
  tool({name: "run_command", status: "completed", rawOutput: {exit_code: 0}}, 2061, "old-tool-0");
  assert.deepEqual(w.turnProgress("c1"), {resumed: false, progress: false});
});
