import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { provider } from "../server/provider.ts";
import { continuationPrompt } from "../server/recovery.ts";

async function setup(t: test.TestContext, scenario: string, cancel = 500, history?: "skip" | "replay") {
  const dir = await mkdtemp(join(tmpdir(), "agy-stall-")), traceFile = join(dir, "trace"), pidFile = join(dir, "pid");
  const log = t.mock.method(console, "log", () => {});
  const c = await provider({checkVersion: async () => "1.5.18",
    limits: {startup: 3000, cancel, stall: 150, quietDiag: 100}, closeTimeoutMs: 100,
  }).connect({versions: [1], capabilities: ["prompt.message", "permission", "session.persistence", "session.configure"],
    launch: {command: process.execPath, args: [fileURLToPath(new URL("./stall-fixture.mjs", import.meta.url))],
      env: {STALL_SCENARIO: scenario, TRACE_FILE: traceFile, PID_FILE: pidFile}}});
  const events: ProviderEvent[] = [];
  c.onEvent(e => events.push(e));
  t.after(async () => {await c.close(); await rm(dir, {recursive: true, force: true});});
  const wait = async (predicate: (e: ProviderEvent) => boolean, from = 0) => {
    for (let i = 0; i < 500; i++) {
      const event = events.slice(from).find(predicate);
      if (event) return event;
      await sleep(10);
    }
    throw new Error("Missing event: " + events.slice(from).map(e => e.type).join(","));
  };
  const prompt = (id = "original", text = "PRIVATE_ORIGINAL") => c.send({type: "session.prompt", sessionId: "s",
    prompt: {clientMessageId: id, delivery: "auto", input: {type: "message", content: [{type: "text", text}]}}});
  const trace = async (): Promise<Array<{method: string; text?: string}>> => {
    try {return (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean).map(s => JSON.parse(s));}
    catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e;}
  };
  await c.send({type: "session.open", sessionId: "s", requestId: "open", history: history ?? "skip",
    ...(history ? {persistence: {version: 1, data: {sessionId: "native"}}} : {}),
    config: {cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true}});
  await wait(e => e.type === "session.ready");
  const pid = Number(await readFile(pidFile, "utf8"));
  return {c, events, wait, prompt, trace, log, pid};
}
const terminal = (e: ProviderEvent) => e.type === "session.turn" && e.state !== "started";
const recoveryNotice = (e: ProviderEvent) => e.type === "session.notice" && e.notice.id.startsWith("antigravity-recovery-");

for (const scenario of ["recover", "tool-recover", "read-docs-recover"]) test(`real SDK cancels ${scenario} and continues once with distinct timeline/turn`, {timeout: 10000}, async t => {
  const h = await setup(t, scenario);
  await h.prompt();
  await h.wait(e => e.type === "session.turn" && e.state === "completed");
  await sleep(200);
  const trace = await h.trace();
  assert.deepEqual(trace.map(r => r.method), ["session/prompt", "session/cancel", "session/prompt"]);
  assert.equal(trace[0].text, "PRIVATE_ORIGINAL");
  assert.equal(trace[2].text, continuationPrompt(150));
  assert.ok(!trace[2].text!.includes("PRIVATE_ORIGINAL"));
  const turns = h.events.filter(e => e.type === "session.turn");
  assert.deepEqual(turns.map(e => e.state), ["started", "canceled", "started", "completed"]);
  assert.notEqual(turns[0].turnId, turns[2].turnId);
  const results = h.events.filter(e => e.type === "session.prompt_result");
  assert.equal(results.length, 1, "only the host-originated prompt gets a host receipt");
  assert.equal(results[0].clientMessageId, "original");
  assert.equal(results[0].result.type, "turn");
  const users = h.events.filter(e => e.type === "timeline.item" && e.item.type === "user_message");
  assert.equal(users.length, 2, "continuation is visible, never hidden raw wire injection");
  assert.ok(h.events.some(e => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text === "RECOVERED"));
  assert.deepEqual(h.events.filter(recoveryNotice).map(e => e.type === "session.notice" && e.notice.id),
    ["antigravity-recovery-cancel", "antigravity-recovery-continuing"]);
  assert.ok(!h.events.some(e => e.type === "session.notice" && ["antigravity-empty", "antigravity-tool-only"].includes(e.notice.id)));
  assert.ok(!h.events.some(e => e.type === "request.completed" && e.requestId.startsWith("antigravity-recovery:")));
  const logs = h.log.mock.calls.map(c => c.arguments);
  assert.ok(!JSON.stringify(logs).includes("PRIVATE_"));
  const phases = logs.filter(r => r[0] === "[antigravity:recovery]").map(r => JSON.parse(r[1] as string).phase);
  assert.ok(phases.includes("output-resumed"));
  assert.ok(phases.includes("finished"));
  for (const [, row] of logs.filter(r => r[0] === "[antigravity:recovery]")) {
    const keys = Object.keys(JSON.parse(row as string));
    assert.ok(keys.every(k => ["sessionId", "turnId", "phase", "continuationUsed", "stallMs"].includes(k)));
  }
});

test("second silent round stops idle, never loops; a new user round gets a fresh allowance", {timeout: 10000}, async t => {
  const h = await setup(t, "repeat");
  await h.prompt();
  await h.wait(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped");
  await sleep(400);
  assert.deepEqual((await h.trace()).map(r => r.method), ["session/prompt", "session/cancel", "session/prompt", "session/cancel"]);
  assert.deepEqual(h.events.filter(e => e.type === "session.turn").map(e => e.state), ["started", "canceled", "started", "canceled"]);
  const from = h.events.length;
  await h.prompt("new-user", "PRIVATE_NEW");
  await h.wait(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-stopped", from);
  assert.equal((await h.trace()).filter(r => r.method === "session/prompt").length, 4);
});
for (const scenario of ["foreground", "approval", "background", "daemon", "subagent", "schedule", "stream", "short"])
  test(`real SDK legitimate wait/output is never interrupted: ${scenario}`, {timeout: 10000}, async t => {
    const h = await setup(t, scenario);
    await h.prompt();
    await h.wait(e => e.type === "session.turn" && e.state === "started");
    await sleep(550);
    assert.equal((await h.trace()).filter(r => r.method === "session/cancel").length, 0);
    assert.ok(!h.events.some(recoveryNotice));
    assert.ok(!h.events.some(e => e.type === "session.runtime_failed"));
    if (scenario === "stream" || scenario === "short") assert.ok(h.events.some(terminal));
  });

for (const kind of ["background", "subagent", "schedule", "daemon", "cron"])
  test(`real SDK background scope after callback/end_turn: ${kind}`, {timeout: 10000}, async t => {
    const h = await setup(t, `scope-${kind}`);
    await h.prompt();
    await h.wait(e => e.type === "timeline.item" && e.item.type === "tool_call");
    await sleep(250);
    assert.equal((await h.trace()).filter(r => r.method === "session/cancel").length, 0);
    await h.wait(e => e.type === "session.turn" && e.state === "completed");
    const from = h.events.length;
    await h.prompt("next-user", "scope-next");
    if (kind === "daemon" || kind === "cron") {
      await sleep(450);
      assert.ok(!h.events.slice(from).some(recoveryNotice));
      assert.equal((await h.trace()).filter(r => r.method === "session/cancel").length, 0);
    } else {
      await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
      assert.deepEqual((await h.trace()).map(r => r.method),
        ["session/prompt", "session/prompt", "session/cancel", "session/prompt"]);
      assert.deepEqual(h.events.filter(e => e.type === "session.prompt_result").map(e => e.clientMessageId),
        ["original", "next-user"], "replacement cleanup still permits internal continuation");
    }
  });
for (const history of ["skip", "replay"] as const)
for (const kind of ["background", "subagent", "schedule", "daemon", "cron"])
  test(`real SDK historical ${kind} never poisons fresh recovery (${history})`, {timeout: 10000}, async t => {
    const h = await setup(t, `history-${kind}`, 500, history);
    const from = h.events.length;
    await h.prompt();
    await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
    assert.deepEqual((await h.trace()).map(r => r.method), ["session/prompt", "session/cancel", "session/prompt"]);
    assert.equal(h.events.filter(e => e.type === "session.prompt_result").length, 1);
  });

for (const action of ["stop", "message", "close"]) test(`user ${action} while automatic cancel is pending invalidates continuation`, {timeout: 10000}, async t => {
  const h = await setup(t, "slow-cancel");
  await h.prompt();
  // Wait for actual wire cancellation, not just its earlier user notice.
  for (let i = 0; i < 300 && !(await h.trace()).some(r => r.method === "session/cancel"); i++) await sleep(5);
  assert.ok((await h.trace()).some(r => r.method === "session/cancel"));
  if (action === "stop") await h.c.send({type: "session.interrupt", sessionId: "s", requestId: "user-stop"});
  else if (action === "message") await h.prompt("next", "user-next");
  else await h.c.send({type: "session.close", sessionId: "s", requestId: "close"});
  await h.wait(e => action === "close" ? e.type === "session.closed" : terminal(e));
  if (action === "message") await h.wait(e => e.type === "session.turn" && e.state === "completed");
  await sleep(400);
  const prompts = (await h.trace()).filter(r => r.method === "session/prompt");
  assert.deepEqual(prompts.map(r => r.text), action === "message" ? ["PRIVATE_ORIGINAL", "user-next"] : ["PRIVATE_ORIGINAL"]);
});
for (const phase of ["cancel", "continuing"]) test(`synchronous user Stop in ${phase} notice wins before automatic dispatch`, {timeout: 10000}, async t => {
  const h = await setup(t, "recover");
  let stop: Promise<void> | undefined;
  h.c.onEvent(e => {
    if (e.type === "session.notice" && e.notice.id === `antigravity-recovery-${phase}`)
      stop = h.c.send({type: "session.interrupt", sessionId: "s", requestId: "user-stop"});
  });
  await h.prompt();
  await h.wait(e => e.type === "request.completed" && e.requestId === "user-stop");
  await stop;
  await sleep(400);
  assert.equal((await h.trace()).filter(r => r.method === "session/prompt").length, 1);
});
for (const scenario of ["end-turn", "cancel-error", "crash-cancel", "late-background"]) test(`unsafe cancellation outcome cannot continue: ${scenario}`, {timeout: 10000}, async t => {
  const h = await setup(t, scenario);
  await h.prompt();
  await h.wait(terminal);
  await sleep(400);
  assert.equal((await h.trace()).filter(r => r.method === "session/prompt").length, 1);
  assert.ok(!h.events.some(e => e.type === "session.notice" && ["antigravity-empty", "antigravity-tool-only"].includes(e.notice.id)));
});
test("automatic cancellation timeout uses existing bounded transport/process fallback", {timeout: 10000}, async t => {
  const h = await setup(t, "ignore", 80);
  await h.prompt();
  const error = await h.wait(e => e.type === "session.runtime_failed");
  assert.ok(error.type === "session.runtime_failed");
  assert.match(error.error.message, /cancel request/i);
  await h.wait(e => e.type === "session.turn" && e.state === "failed");
  await sleep(200);
  assert.deepEqual((await h.trace()).map(r => r.method), ["session/prompt", "session/cancel"]);
  let gone = false;
  for (let i = 0; i < 200; i++) {
    try {process.kill(h.pid, 0);} catch (e) {
      assert.equal((e as NodeJS.ErrnoException).code, "ESRCH"); gone = true; break;
    }
    await sleep(10);
  }
  assert.ok(gone, "SIGTERM-ignoring fixture must be reaped by existing process-group fallback");
});
test("continuation is not admitted behind a pending SDK configuration mutation", {timeout: 10000}, async t => {
  const h = await setup(t, "slow-config");
  let configure: Promise<void> | undefined;
  h.c.onEvent(e => {
    if (e.type === "session.turn" && e.state === "canceled")
      configure = h.c.send({type: "session.configure", sessionId: "s", requestId: "configure", changes: {mode: "other"}});
  });
  await h.prompt();
  await h.wait(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-aborted");
  await configure;
  await h.wait(e => e.type === "request.completed" && e.requestId === "configure");
  assert.equal((await h.trace()).filter(r => r.method === "session/prompt").length, 1);
});
test("automatic Stop delivery is bounded behind a blocked SDK write queue", {timeout: 10000}, async t => {
  const h = await setup(t, "blocked-write", 80);
  await h.prompt("large", "x".repeat(4 * 1024 * 1024));
  const error = await h.wait(e => e.type === "session.runtime_failed");
  assert.ok(error.type === "session.runtime_failed");
  assert.match(error.error.message, /stop request.*transmitting/i);
  await h.wait(e => e.type === "session.turn" && e.state === "failed");
  await sleep(200);
  assert.equal(h.events.filter(e => e.type === "session.turn" && e.state === "started").length, 1);
  assert.ok(!h.events.some(e => e.type === "session.notice" && e.notice.id === "antigravity-recovery-continuing"));
});
test("Stop before threshold suppresses all recovery", {timeout: 10000}, async t => {
  const h = await setup(t, "recover");
  await h.prompt();
  await h.wait(e => e.type === "timeline.item" && e.item.type === "reasoning");
  await h.c.send({type: "session.interrupt", sessionId: "s", requestId: "user-stop"});
  await h.wait(terminal);
  await sleep(400);
  assert.ok(!h.events.some(recoveryNotice));
  assert.equal((await h.trace()).filter(r => r.method === "session/prompt").length, 1);
});
