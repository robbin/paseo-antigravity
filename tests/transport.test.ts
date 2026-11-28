import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createTransport } from "../server/transport.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
const ctx = { cwd: process.cwd(), env: {} };
const make = (code: string) =>
  createTransport(
    {
      command: process.execPath,
      args: ["-e", code],
      env: process.env as Record<string, string>,
    },
    ctx,
    () => {},
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test("valid frame before immediate process exit is not discarded", async () => {
  const t = make(
    `console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}}))`,
  );
  try {
    const r = t.stream.readable.getReader();
    assert.deepEqual((await r.read()).value, {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    assert.equal((await r.read()).done, true);
  } finally {
    await t.close();
  }
});
test("spawn failure becomes a stream error and cleanup settles", async () => {
  const t = createTransport(
    { command: "/nonexistent/agy", args: [], env: {} },
    ctx,
    () => {},
  );
  try {
    await assert.rejects(t.stream.readable.getReader().read(), /start official agy/i);
  } finally {
    await t.close();
  }
});
test("closing is idempotent and kills a SIGTERM-ignoring process", async () => {
  const t = make(
    `process.on('SIGTERM',()=>{});console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));setInterval(()=>{},1000);`,
  );
  await t.stream.readable.getReader().read();
  await Promise.all([t.close(), t.close()]);
  await sleep(50);
  assert.equal(alive(t.pid!), false);
});
test("cleanup owns descendants even after the launcher exits", async () => {
  const t = make(
    `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:c.pid}}));setTimeout(()=>process.exit(0),60);`,
  );
  const m = await t.stream.readable.getReader().read();
  const pid = (m.value as { result: { pid: number } }).result.pid;
  try {
    await sleep(120);
    await t.close();
    await sleep(80);
    assert.equal(alive(pid), false);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await t.close();
  }
});
test("browser login text becomes actionable error without opening browser", async () => {
  const t = make(
    `console.log('Open the following link to authenticate the ACP server: fixture');setInterval(()=>{},1000)`,
  );
  try {
    await assert.rejects(t.stream.readable.getReader().read(), /Sign in with agy/i);
  } finally {
    await t.close();
  }
});
test("cancel stream alone cleans up child", async () => {
  const t = make(`setInterval(()=>{},1000)`);
  await t.stream.readable.cancel();
  await sleep(40);
  assert.equal(alive(t.pid!), false);
});
test("native cwd and environment are preserved", async () => {
  const t = createTransport(
    {
      command: process.execPath,
      args: [
        "-e",
        `console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{cwd:process.cwd(),a:process.env.AUDIT_A,home:process.env.GEMINI_HOME}}));setInterval(()=>{},1000);`,
      ],
      env: { AUDIT_A: "launch", GEMINI_HOME: "/fixture-original" },
    },
    { cwd: "/tmp", env: { AUDIT_A: "session" } },
    () => {},
  );
  try {
    const m = await t.stream.readable.getReader().read();
    assert.deepEqual((m.value as { result: unknown }).result, {
      cwd: "/private/tmp",
      a: "session",
      home: "/fixture-original",
    });
  } finally {
    await t.close();
  }
});
