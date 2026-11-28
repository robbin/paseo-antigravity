import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { provider } from "../server/provider.ts";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

const fixture = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line), reply = result => send({id:m.id,result});
  const scenario = process.env.SCENARIO;
  if (m.method === 'initialize') {
    if (scenario === 'init-exit') process.exit(19);
    reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}}});
  }
  if (m.method === 'session/list') {
    reply({sessions:[{sessionId:'saved',cwd:m.params.cwd ?? process.cwd(),title:process.cwd()}]});
  }
  if (m.method === 'session/new' || m.method === 'session/load') {
    if (scenario === 'exit') process.exit(17);
    if (scenario === 'signal') { process.kill(process.pid,'SIGTERM'); return; }
    if (scenario === 'error') {
      send({id:m.id,error:{code:-32001,message:'fixture specific open failure'}});
      setTimeout(() => process.exit(23), 10);
      return;
    }
    reply(m.method === 'session/new' ? {sessionId:'native',configOptions:[]} : {});
    send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
  }
  if (m.method === 'session/close') reply({});
});`;

async function setup() {
  const c = await provider({ checkVersion: async () => "1.5.15" }).connect({
    versions: [1],
    capabilities: ["session.list", "session.persistence"],
    launch: { command: process.execPath, args: ["-e", fixture], env: {} },
  });
  const events: ProviderEvent[] = [];
  c.onEvent(e => events.push(e));
  const send = async (input: ProviderInput & { requestId: string }) => {
    const from = events.length;
    await c.send(input);
    for (let i = 0; i < 500; i++) {
      const result = events.slice(from).find(e =>
        "requestId" in e && e.requestId === input.requestId &&
        ["request.failed", "sessions", "session.ready", "request.completed"].includes(e.type));
      if (result) return result;
      await sleep(10);
    }
    throw new Error("Missing completion for " + input.requestId);
  };
  return { c, send };
}

function open(requestId: string, sessionId: string, scenario: string, restore = false): ProviderInput & {requestId: string} {
  return {
    type: "session.open", requestId, sessionId, history: "skip",
    config: { cwd: tmpdir(), env: {SCENARIO: scenario}, mcpServers: {}, settings: {}, persist: true },
    ...(restore ? { persistence: {version: 1, data: {sessionId: "native"}} } : {}),
  };
}

test("session-list cwd is only a filter, including a deleted directory", {timeout: 10000}, async () => {
  const removed = mkdtempSync(join(tmpdir(), "agy-deleted-list-"));
  rmSync(removed, {recursive: true});
  const h = await setup();
  try {
    for (const cwd of [undefined, tmpdir(), removed]) {
      const event = await h.send({type: "sessions", requestId: "list", ...(cwd ? {cwd} : {})});
      assert.equal(event.type, "sessions", JSON.stringify(event));
      if (event.type !== "sessions") continue;
      assert.equal(event.sessions[0].cwd, cwd ?? homedir());
      // The CLI starts in home even when the filter happens to be a valid directory.
      assert.equal(event.sessions[0].title, homedir());
    }
  } finally { await h.c.close(); }
});

for (const restore of [false, true]) for (const scenario of ["exit", "signal", "init-exit"]) {
  test(`open failure retains transport root cause (${scenario}, restore=${restore})`, {timeout: 10000}, async () => {
    const h = await setup();
    try {
      const event = await h.send(open("open", "s", scenario, restore));
      assert.equal(event.type, "request.failed");
      if (event.type !== "request.failed") return;
      assert.match(event.error.message, scenario === "signal" ? /signal SIGTERM/ :
        scenario === "init-exit" ? /exit code 19/ : /exit code 17/);
    } finally { await h.c.close(); }
  });
}

test("concurrent failures stay request-scoped and reused IDs cannot inherit diagnostics", {timeout: 10000}, async () => {
  const h = await setup();
  try {
    const results = await Promise.all([
      h.send(open("first", "a", "exit")),
      h.send(open("second", "b", "signal")),
    ]);
    for (const [index, event] of results.entries()) {
      assert.equal(event.type, "request.failed");
      if (event.type === "request.failed")
        assert.match(event.error.message, index === 0 ? /exit code 17/ : /signal SIGTERM/);
    }
    const specific = await h.send(open("first", "a", "error"));
    assert.equal(specific.type, "request.failed");
    if (specific.type === "request.failed")
      assert.equal(specific.error.message, "fixture specific open failure");
    const ready = await h.send(open("first", "a", ""));
    assert.equal(ready.type, "session.ready", JSON.stringify(ready));
    await assert.rejects(h.c.send(open("first", "a", "exit")), /Session already exists/);
    // Admission rejection must release the ID for unrelated requests.
    assert.equal((await h.send({type: "sessions", requestId: "first"})).type, "sessions");
  } finally { await h.c.close(); }
});
