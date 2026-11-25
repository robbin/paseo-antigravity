import test from "node:test";
import assert from "node:assert/strict";
import { createTransport } from "../server/transport.ts";
import { vendor } from "../server/vendor.ts";
import { Watch } from "../server/watch.ts";
import { provider } from "../server/provider.ts";
import { fileURLToPath } from "node:url";

test("command classification preserves metadata and leaves unknown names neutral", () => {
  const context = {sessionId:"s"};
  assert.equal(vendor.command!({name:"swarm",description:""},context).kind,"command");
  assert.equal(vendor.command!({name:"new-command",description:""},context).kind,undefined);
  assert.equal(vendor.command!({name:"custom-skill",description:"",kind:"skill"},context).kind,"skill");
  assert.equal(vendor.command!({name:"plan",description:"",kind:"skill"},context).kind,"skill");
});

test("load response is not held behind continuous live updates", { timeout: 5000 }, async () => {
  const code = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line),send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));
    send({id:m.id,result:{}});
    setInterval(()=>send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'live'}}}}),30);
  });`;
  const t = createTransport({command:process.execPath,args:["-e",code],env:{}},
    {cwd:process.cwd(),env:{}},()=>{}, {startup:1000,cancel:500});
  try {
    await t.stream.writable.getWriter().write({jsonrpc:"2.0",id:1,method:"session/load",params:{sessionId:"s"}});
    const first = (await t.stream.readable.getReader().read()).value;
    assert.ok(first && "id" in first && first.id === 1, "native load response must preserve wire order");
  } finally { await t.close(); }
});

test("watch ends replay at load response and tracks autonomous live tools", () => {
  const w = new Watch({startup:100,cancel:20});
  const update = (id:string) => ({jsonrpc:"2.0" as const,method:"session/update",params:{sessionId:"s",update:{sessionUpdate:"tool_call",toolCallId:id,status:"in_progress"}}});
  w.observe("out",{jsonrpc:"2.0",id:1,method:"session/load",params:{sessionId:"s"}},0);
  w.observe("in",update("historical"),1);
  w.observe("in",{jsonrpc:"2.0",id:1,result:{}},2);
  w.observe("in",update("live"),3);
  w.observe("out",{jsonrpc:"2.0",method:"session/cancel",params:{sessionId:"s"}},4);
  assert.match(w.check(25).failure ?? "", /取消/);
});

for (const version of ["1.5.14", "unknown"]) {
  test(`direct connect rejects unsupported CLI ${version}`, async () => {
    await assert.rejects(provider().connect({versions:[1],capabilities:[],
      launch:{command:process.execPath,
        args:[fileURLToPath(new URL("./fixture.mjs",import.meta.url)),"acp"],
        env:{CLI_VERSION:version}}}), /1\.5\.15/);
  });
}
test("direct connect cannot bypass version check by omitting acp", async () => {
  await assert.rejects(provider().connect({versions:[1],capabilities:[],
    launch:{command:process.execPath,args:[],env:{}}}), /必须包含 acp/);
});
test("direct connect accepts supported CLI without status probe", async () => {
  const c = await provider().connect({versions:[1],capabilities:[],
    launch:{command:process.execPath,args:[fileURLToPath(new URL("./fixture.mjs",import.meta.url)),"acp"],
      env:{CLI_VERSION:"1.5.15"}}});
  await c.close();
});

for (const [version, available] of [["1.5.0",false],["1.5.14",false],["1.5.15",true],["1.5.16",true],["1.6.0",true],["2.0.0",true],["unknown",false]] as const) {
  test(`minimum CLI version: ${version}`, async () => {
    const result = await provider().status!({launch:{command:process.execPath,
      args:[fileURLToPath(new URL("./fixture.mjs",import.meta.url)),"acp"],env:{CLI_VERSION:version}}});
    assert.equal(result.available,available);
    if (!available) assert.match(result.diagnostic ?? "", /1\.5\.15/);
  });
}
