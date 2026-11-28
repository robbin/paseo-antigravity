import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import { Activity } from "../server/activity.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
const make = () => new Watch({startup:100000,cancel:50,quietDiag:100});
const frame = (w:Watch, d:"in"|"out", m:object, now=0) => w.observe(d,{jsonrpc:"2.0",...m} as AcpStreamMessage,now);
const prompt=(w:Watch,id=1,at=0)=>frame(w,"out",{id,method:"session/prompt",params:{sessionId:"s"}},at);
const update=(w:Watch,u:object,at=0,sid="s")=>frame(w,"in",{method:"session/update",params:{sessionId:sid,update:u}},at);

test("Stop token survives turn changes, repeats do not extend first deadline",t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();w.startTurn("one",0);prompt(w);
 const first=w.requestStop(1)!;w.requestStop(20);
 w.endTurn("one");w.startTurn("two",30);
 assert.deepEqual(w.check(50),{});assert.match(w.check(51).failure!,/stop request/i);
 w.settleStop(first);assert.deepEqual(w.check(69),{});
 assert.match(w.check(70).failure!,/stop request/i);
});
test("idle Stop and settled/rejected tokens cannot poison future work",t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();assert.equal(w.requestStop(0),undefined);
 w.startTurn("one",0);const token=w.requestStop(1)!;
 w.settleStop(token);w.settleStop(token);
 w.endTurn("one");w.startTurn("two",200);
 assert.deepEqual(w.check(1000),{});
});
test("two-phase Stop leaves wire cancellation its original deadline",t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();w.startTurn("one",0);prompt(w);
 const token=w.requestStop(1)!;
 frame(w,"out",{method:"session/cancel",params:{sessionId:"s"}},45);
 w.settleStop(token);
 assert.deepEqual(w.check(94),{});assert.match(w.check(95).failure!,/cancel request/i);
});
test("restored approval without turn admits a Stop",t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();frame(w,"out",{id:1,method:"session/load",params:{sessionId:"s"}});
 frame(w,"in",{id:2,method:"session/request_permission",params:{sessionId:"s"}});
 assert.notEqual(w.requestStop(1),undefined);assert.match(w.check(51).failure!,/stop request/i);
});
for(const backward of [false,true]) test(`Stop and quiet clocks rebase (backward=${backward})`,t=>{
 const log=t.mock.method(console,"log",()=>{}),w=make();w.startTurn("one",100);prompt(w,1,100);w.requestStop(100);
 const now=backward?0:10000;w.resume(now,100);
 assert.deepEqual(w.check(now+49),{});
 assert.match(w.check(now+50).failure!,/stop request/i);
 assert.ok(!log.mock.calls.some(c=>c.arguments[0]==="[antigravity:quiet]"));
});
for(const kind of [undefined,"agent_thought_chunk","tool_call","compaction_update","agent_message_chunk"])
 test(`quiet snapshot once, no termination (${kind})`,t=>{
  const log=t.mock.method(console,"log",()=>{}),w=make();w.startTurn("one",0);prompt(w);
  if(kind)update(w,{sessionUpdate:kind,content:{type:"text",text:"PRIVATE_TEXT"},name:"PRIVATE_TOOL",rawInput:{path:"PRIVATE_PATH"}},10);
  const at=kind?10:0;
  assert.deepEqual(w.check(at+99),{});assert.equal(log.mock.calls.length,0);
  assert.deepEqual(w.check(at+100),{});assert.deepEqual(w.check(10000),{});
  update(w,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"PRIVATE_REPLY"}},10001);
  assert.deepEqual(w.check(20000),{});
  const quiet=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:quiet]");assert.equal(quiet.length,1);
  assert.ok(!JSON.stringify(log.mock.calls.map(c=>c.arguments)).includes("PRIVATE_"));
  w.endTurn("one");w.startTurn("two",20001);w.check(20101);
  assert.equal(log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:quiet]").length,2);
 });
test("live prompt count handles same-turn steer; replay/other session does not advance live clock",t=>{
 const log=t.mock.method(console,"log",()=>{}),w=make();w.startTurn("one",0);prompt(w);
 frame(w,"in",{id:1,result:{stopReason:"end_turn"}},10);prompt(w,2,20);
 frame(w,"out",{id:3,method:"session/load",params:{sessionId:"other"}},30);
 update(w,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"PRIVATE_HISTORY"}},100,"other");
 w.check(110);
 const data=JSON.parse(log.mock.calls.find(c=>c.arguments[0]==="[antigravity:quiet]")!.arguments[1] as string);
 assert.equal(data.openPrompts,1);assert.equal(data.promptResponses,1);assert.equal(data.textEvents,0);
});
test("old tool completions and retired echoes do not postpone current turn quiet snapshot",t=>{
 const log=t.mock.method(console,"log",()=>{}),w=make();
 w.startTurn("old",0);prompt(w,1,0);
 update(w,{sessionUpdate:"tool_call",toolCallId:"old-tool",status:"in_progress"},1);
 w.endTurn("old");w.startTurn("new",10);prompt(w,2,10);
 update(w,{sessionUpdate:"tool_call_update",toolCallId:"old-tool",status:"completed"},90);
 w.check(110);
 let quiet=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:quiet]");
 assert.equal(quiet.length,1);assert.equal(JSON.parse(quiet[0].arguments[1] as string).toolEvents,0);
 w.endTurn("new");w.startTurn("third",120);prompt(w,3,120);
 update(w,{sessionUpdate:"tool_call_update",toolCallId:"old-tool",status:"completed"},180);
 w.check(220);quiet=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:quiet]");
 assert.equal(quiet.length,2);assert.equal(JSON.parse(quiet[1].arguments[1] as string).toolEvents,0);
});
for(const backward of [false,true]) test(`quiet clock alone rebases (backward=${backward})`,t=>{
 const log=t.mock.method(console,"log",()=>{}),w=make();w.startTurn("one",100);prompt(w,1,100);
 const now=backward?0:10000;w.resume(now,100);
 w.check(now+99);assert.equal(log.mock.calls.length,0);
 w.check(now+100);assert.equal(log.mock.calls.length,1);
 assert.equal(log.mock.calls[0].arguments[0],"[antigravity:quiet]");
});
test("pending write is not successful activity; stale callbacks and unknown method cannot leak",t=>{
 const log=t.mock.method(console,"log",()=>{}),a=new Activity(100);
 const counts={openPrompts:1,openTools:0,approvals:0};
 a.start("one",0);const seq=a.writeStart("PRIVATE_METHOD",50);
 a.writeEnd(seq-1,true,95);a.check(100,50,counts);
 const data=JSON.parse(log.mock.calls[0].arguments[1] as string);
 assert.equal(data.pendingWrite,"other");assert.equal(data.pendingWriteAgeMs,50);assert.equal(data.lastWriteCompletedAgeMs,null);
 assert.deepEqual(Object.keys(data).sort(),["transportId","turnId","turnAgeMs","quietAgeMs","firstInboundAgeMs","lastInboundAgeMs","lastWriteCompletedAgeMs","pendingWrite","pendingWriteAgeMs","openPrompts","openTools","approvals","promptResponses","textEvents","thoughtEvents","toolEvents","approvalEvents","compactionEvents"].sort());
 a.writeEnd(seq,false,101);a.clear();assert.equal(a.check(200,50,counts),undefined);
 assert.ok(!JSON.stringify(log.mock.calls.map(c=>c.arguments)).includes("PRIVATE_"));
});
test("successful write advances quiet clock without claiming upstream receipt",t=>{
 const log=t.mock.method(console,"log",()=>{}),a=new Activity(100),counts={openPrompts:1,openTools:0,approvals:0};
 a.start("one",0);const seq=a.writeStart("session/prompt",1);a.writeEnd(seq,true,90);
 a.check(189,50,counts);assert.equal(log.mock.calls.length,0);a.check(190,50,counts);
 const data=JSON.parse(log.mock.calls[0].arguments[1] as string);assert.equal(data.lastWriteCompletedAgeMs,100);assert.equal(data.firstInboundAgeMs,null);
});
