import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { provider } from "../server/provider.ts";
import { createTransport } from "../server/transport.ts";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

// A real pipe, real SDK and real Provider; only the upstream CLI is simulated.
const fixture = `
const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const lines = readline.createInterface({input:process.stdin});
let pending;
setInterval(()=>{},1000);
lines.on('line', line => {
 const m=JSON.parse(line), reply=result=>send({id:m.id,result});
 if(m.method==='initialize') reply({protocolVersion:1,agentCapabilities:{}});
 if(m.method==='session/new') {
  reply({sessionId:'native',configOptions:[]});
  send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
  if(!process.env.DEFER && !process.env.APPROVAL_BLOCK) process.stdin.pause();
  if(process.env.RESUME_MS) setTimeout(()=>process.stdin.resume(),Number(process.env.RESUME_MS));
 }
 if(m.method==='session/prompt') {
  pending=m.id;
  if(process.env.APPROVAL_BLOCK) {
   send({id:'approve',method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:'approval',title:'approval',status:'pending'},options:[{optionId:'x'.repeat(4*1024*1024),name:'Allow',kind:'allow_once'}]}});
   process.stdin.pause();
   setTimeout(()=>{
    if(process.env.TOOL_ONLY) send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:'done',title:'done',kind:'execute',name:'run_command',status:'completed',rawInput:{},rawOutput:'ok'}}});
    reply({stopReason:'end_turn'});
   },300);
  }
  if(process.env.DEFER && m.params.prompt[0].text==='defer') {
   send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:'worker',title:'worker',kind:'execute',status:'in_progress',rawInput:{}}}});
   reply({stopReason:'end_turn'});pending=undefined;process.stdin.pause();
  }
 }
 if(m.method==='session/cancel' && pending!==undefined) {send({id:pending,result:{stopReason:'cancelled'}});pending=undefined;}
});`;

for (const mode of ["blocked", "resume", "deferred"]) {
  const resume=mode==="resume", deferred=mode==="deferred";
  test(`Stop bypasses stalled SDK write queue (${mode})`, {timeout:10000}, async t => {
    const log=t.mock.method(console,"log",()=>{});
    const c = await provider({checkVersion:async()=>"1.5.17", limits:{startup:2000,cancel:deferred?100:500,quietDiag:80},closeTimeoutMs:100}).connect({
      versions:[1],capabilities:["prompt.message","prompt.steer","session.configure"],
      launch:{command:process.execPath,args:["-e",fixture],env:resume?{RESUME_MS:"200"}:deferred?{DEFER:"1"}:{}},
    });
    const events:ProviderEvent[]=[];
    c.onEvent(e=>events.push(e));
    async function wait(predicate:(e:ProviderEvent)=>boolean) {
      for(let i=0;i<300;i++) {const e=events.find(predicate);if(e)return e;await sleep(10);}
      throw new Error("Missing expected event; got "+events.map(e=>e.type).join(","));
    }
    try {
      await c.send({type:"session.open",sessionId:"s",requestId:"open",history:"skip",config:{cwd:process.cwd(),env:{},mcpServers:{},settings:{},persist:true}});
      await wait(e=>e.type==="session.ready");
      if(deferred) {
        await c.send({type:"session.prompt",sessionId:"s",prompt:{clientMessageId:"first",delivery:"auto",input:{type:"message",content:[{type:"text",text:"defer"}]}}});
        await wait(e=>e.type==="timeline.item"&&e.item.type==="tool_call");
        await sleep(50); // SDK drains notifications before entering deferred mode.
      }
      await c.send({type:"session.prompt",sessionId:"s",prompt:{clientMessageId:"large",delivery:deferred?"steer":"auto",input:{type:"message",content:[{type:"text",text:"x".repeat(4*1024*1024)}]}}});
      await wait(e=>e.type==="session.turn"&&e.state==="started");
      if (!resume) {
        const configure=c.send({type:"session.configure",sessionId:"s",requestId:"shared",changes:{}});
        await assert.rejects(c.send({type:"session.interrupt",sessionId:"s",requestId:"shared"}));
        await configure;
        await wait(e=>e.type==="request.completed"&&e.requestId==="shared");
        // A completed non-Stop request releases its reservation for legitimate reuse.
        await c.send({type:"session.configure",sessionId:"s",requestId:"shared",changes:{}});
      }
      // Invalid admission cannot arm a deadline, even with an existing transport.
      await assert.rejects(c.send({type:"session.interrupt",sessionId:"s",requestId:"invalid-stop",unexpected:true} as never));
      if (!resume) {
        await sleep(1100);
        assert.ok(!events.some(e=>e.type==="session.runtime_failed"),"rejected Stop must roll back");
        assert.equal(log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:quiet]").length,1);
        assert.ok(!events.some(e=>e.type==="session.notice"),"quiet diagnostics must not create timeline notices");
      }
      await c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
      if (!resume) {
        await assert.rejects(c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"}));
        await c.send({type:"session.interrupt",sessionId:"s",requestId:"stop-again"});
      }
      if(resume) {
        await wait(e=>e.type==="session.turn"&&e.state==="canceled");
        await sleep(650);
        assert.ok(!events.some(e=>e.type==="session.runtime_failed"));
      } else {
        const failure=await wait(e=>e.type==="session.runtime_failed");
        assert.ok(failure.type==="session.runtime_failed");
        assert.match(failure.error.message,/停止请求.*传输/);
        await wait(e=>(e.type==="request.failed"||e.type==="request.completed")&&e.requestId==="stop");
        await wait(e=>(e.type==="request.failed"||e.type==="request.completed")&&e.requestId==="stop-again");
        if (!deferred) {
          await c.send({type:"session.close",sessionId:"s",requestId:"close"});
          await wait(e=>e.type==="session.closed");
          events.length=0;
          await c.send({type:"session.open",sessionId:"s",requestId:"open",history:"skip",config:{cwd:process.cwd(),env:{},mcpServers:{},settings:{},persist:true}});
          await wait(e=>e.type==="session.ready");
          await c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
          await wait(e=>e.type==="request.completed"&&e.requestId==="stop");
          await sleep(1100);
          assert.ok(!events.some(e=>e.type==="session.runtime_failed"),"reopened transport must not inherit old Stop tokens");
        }
      }
    } finally {await c.close();}
  });
}

for(const toolOnly of [false,true]) for(const rejected of [false,true])
test(`turn ending behind approval write (toolOnly=${toolOnly}, rejected=${rejected})`, {timeout:10000}, async t=>{
 const log=t.mock.method(console,"log",()=>{});
 const c=await provider({checkVersion:async()=>"1.5.17",limits:{startup:2000,cancel:800},closeTimeoutMs:100}).connect({versions:[1],capabilities:["prompt.message","permission"],launch:{command:process.execPath,args:["-e",fixture],env:{APPROVAL_BLOCK:"1",...(toolOnly?{TOOL_ONLY:"1"}:{})}}});
 const events:ProviderEvent[]=[];c.onEvent(e=>events.push(e));
 const wait=async(p:(e:ProviderEvent)=>boolean)=>{
  for(let i=0;i<400;i++){const e=events.find(p);if(e)return e;await sleep(10);}throw Error("missing event");
 };
 try {
  await c.send({type:"session.open",sessionId:"s",requestId:"open",history:"skip",config:{cwd:process.cwd(),env:{},mcpServers:{},settings:{},persist:true}});
  await wait(e=>e.type==="session.ready");
  await c.send({type:"session.prompt",sessionId:"s",prompt:{clientMessageId:"first",delivery:"auto",input:{type:"message",content:[{type:"text",text:"permission"}]}}});
  const approval=await wait(e=>e.type==="session.permission");assert.ok(approval.type==="session.permission");
  await c.send({type:"session.permission",sessionId:"s",permissionId:approval.request.id,response:{behavior:"allow",selectedActionId:"x".repeat(4*1024*1024)}});
  await sleep(30);
  if(rejected) await assert.rejects(c.send({type:"session.interrupt",sessionId:"s",requestId:"stop",unexpected:true} as never));
  else await c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
  const end=await wait(e=>e.type==="session.turn"&&e.state!=="started");
  if(toolOnly) assert.ok(events.some(e=>e.type==="timeline.item"&&e.item.type==="tool_call"&&e.item.status==="completed"));
  if(rejected) {
    await sleep(1100);
    assert.ok(!events.some(e=>e.type==="session.runtime_failed"));
    const notices=events.filter(e=>e.type==="session.notice");
    assert.equal(notices.length,1);
    assert.equal(notices[0].notice.id,toolOnly?"antigravity-tool-only":"antigravity-empty");
    const terminal=JSON.parse(log.mock.calls.find(c=>c.arguments[0]==="[antigravity:turn-end]")!.arguments[1] as string);
    assert.equal(terminal.canceled,false);
    const phases=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:stop]").map(c=>JSON.parse(c.arguments[1] as string).phase);
    assert.deepEqual(phases,["requested","rejected"]);
    return;
  }
  const failure=await wait(e=>e.type==="session.runtime_failed");
  assert.ok(failure.type==="session.runtime_failed");assert.match(failure.error.message,/停止请求.*传输/);
  assert.ok(events.indexOf(end)<events.indexOf(failure),"normal turn settlement must precede delivery timeout");
  assert.ok(!events.some(e=>e.type==="session.notice"),"accepted Stop must suppress empty/tool-only notices even before its frame is written");
  const terminal=JSON.parse(log.mock.calls.find(c=>c.arguments[0]==="[antigravity:turn-end]")!.arguments[1] as string);
  assert.equal(terminal.canceled,true);
  const stopLogs=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:stop]").map(c=>JSON.parse(c.arguments[1] as string));
  assert.equal(stopLogs.find(r=>r.phase==="timeout").turnId,"acp:first");
  assert.ok(log.mock.calls.some(c=>c.arguments[0]==="[antigravity:stop]"&&String(c.arguments[1]).includes('"phase":"timeout"')));
 } finally {await c.close();}
});

test("owned close releases blocked write before SIGTERM grace, then reaps child", {timeout:5000}, async () => {
  const t=createTransport({command:process.execPath,args:["-e",`process.on('SIGTERM',()=>{});console.log(JSON.stringify({jsonrpc:'2.0',id:0,result:{}}));setInterval(()=>{},1000)`],env:{}},{cwd:process.cwd(),env:{}},()=>{});
  const r=t.stream.readable.getReader(),w=t.stream.writable.getWriter();
  try {
    await r.read(); // SIGTERM handler is installed; child never reads stdin.
    const write=w.write({jsonrpc:"2.0",id:1,method:"session/prompt",params:{sessionId:"s",prompt:[{type:"text",text:"x".repeat(4*1024*1024)}]}});
    let rejected=false;const result=write.catch(()=>{rejected=true;});
    await sleep(30);
    const closing=t.close();
    assert.equal(t.close(),closing);
    await sleep(30);assert.equal(rejected,true,"write must not wait for process-group grace");
    await closing;await result;await t.finished;
    for(let i=0;i<100;i++) {
      try {process.kill(t.pid!,0);} catch(e) {assert.equal((e as NodeJS.ErrnoException).code,"ESRCH");return;}
      await sleep(10);
    }
    assert.fail("child survived owned close");
  } finally {await t.close();}
});
