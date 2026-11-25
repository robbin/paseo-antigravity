import test from "node:test";
import assert from "node:assert/strict";
import { Watch } from "../server/watch.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
for (const followupTool of [false,true]) {
  test(`same-turn steering retains whole-turn notice semantics (new tool=${followupTool})`,()=>{
    const w = new Watch(); w.startTurn("turn",0);
    const send = (direction:"in"|"out",m:object) => w.observe(direction,{jsonrpc:"2.0",...m} as AcpStreamMessage,1);
    const prompt = (id:number) => send("out",{id,method:"session/prompt",params:{sessionId:"s"}});
    const update = (update:object) => send("in",{method:"session/update",params:{sessionId:"s",update}});
    prompt(1);
    update({sessionUpdate:"tool_call_update",toolCallId:"old",status:"completed"});
    update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"answer after old tool"}});
    prompt(2);
    if(followupTool) update({sessionUpdate:"tool_call_update",toolCallId:"new",status:"completed"});
    assert.equal(w.turn!.trailingText,!followupTool);
    assert.equal(w.turn!.text,true);
    assert.equal(w.turn!.completed,followupTool ? 2 : 1);
  });
}
