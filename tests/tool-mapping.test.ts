import test from "node:test";
import assert from "node:assert/strict";
import { mapToolCall } from "../server/tool-calls.ts";
import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
const call = (fields: Partial<AcpToolCallSnapshot>): AcpToolCallSnapshot => ({
  id:"t",title:"fixture",status:"completed",input:null,output:null,locations:[],...fields,
});
const outputs: AcpToolCallSnapshot["output"][] = ["", "中".repeat(500000), {content:"native"}, {text:"native"}, null, {unexpected:"not text"}];
for (const output of outputs) {
  test(`read/search content preserves explicit result shape ${typeof output}`,()=>{
    const content = typeof output === "string" ? output : output && typeof output === "object" && ("content" in output || "text" in output) ? "native" : undefined;
    for (const name of ["read_file","search_web"]) {
      const mapped = mapToolCall(call({name,kind:name === "read_file" ? "read" : "search",
        input:name === "read_file" ? {Path:"/tmp/file",StartLine:2,EndLine:5} : {query:"test"},output}),{sessionId:"s"});
      const detail = mapped.detail;
      assert.ok(detail?.type === "read" || detail?.type === "search");
      assert.equal(detail.content,content);
      if(detail.type === "read") { assert.equal(detail.offset,2); assert.equal(detail.limit,4); }
    }
  });
}
for (const replacement of ["", " \n"]) {
  test(`edit mapping preserves original input and whitespace (${JSON.stringify(replacement)})`,()=>{
    const source = call({name:"edit_file",kind:"edit",status:"failed",input:{Path:"/tmp/file",Target:" \n",Replacement:replacement}});
    const before = structuredClone(source);
    const mapped = mapToolCall(source,{sessionId:"s"});
    assert.deepEqual(source,before);
    assert.equal(mapped.detail,undefined);
    assert.deepEqual(mapped.input,{Path:"/tmp/file",Target:" \n",Replacement:replacement,
      filePath:"/tmp/file",oldString:" \n",newString:replacement});
  });
}
