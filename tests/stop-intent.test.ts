import test from "node:test";
import assert from "node:assert/strict";
import { Watch, turnMetadata } from "../server/watch.ts";

const make = () => new Watch({startup:1000,cancel:50});
test("Stop intent survives settlement; rejection removes only its own intent", t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();w.startTurn("original",0);const owner=w.turn!;
 const first=w.requestStop(1)!,second=w.requestStop(2)!;
 assert.equal(turnMetadata(owner).canceled,true);
 w.settleStop(first,true);assert.equal(turnMetadata(owner).canceled,true);
 w.settleStop(second,true);assert.equal(turnMetadata(owner).canceled,false);
 const accepted=w.requestStop(3)!;w.settleStop(accepted);
 assert.equal(turnMetadata(owner).canceled,true);
 w.settleStop(accepted,true);assert.equal(turnMetadata(owner).canceled,true);
 assert.deepEqual(w.check(100),{});
});
test("rollback uses captured turn, not a successor, and never clears wire cancellation", t=>{
 t.mock.method(console,"log",()=>{});
 const w=make();w.startTurn("old",0);const old=w.turn!,token=w.requestStop(1)!;
 w.endTurn("old");w.startTurn("new",2);const next=w.turn!;
 w.settleStop(token,true);
 assert.equal(turnMetadata(old).canceled,false);assert.equal(turnMetadata(next).canceled,false);
 const pending=w.requestStop(3)!;next.canceled=true;w.settleStop(pending,true);
 assert.equal(turnMetadata(next).canceled,true);
});
test("Stop logs preserve original turn and allowlist across turn changes and rejection", t=>{
 const log=t.mock.method(console,"log",()=>{}),w=make();w.startTurn("original",0);
 w.activity.writeStart("PRIVATE_METHOD",0);
 const first=w.requestStop(1)!,second=w.requestStop(2)!;
 w.endTurn("original");w.startTurn("successor",3);
 w.settleStop(second,true);assert.match(w.check(51).failure!,/stop request/i);w.settleStop(first);
 const rows=log.mock.calls.filter(c=>c.arguments[0]==="[antigravity:stop]").map(c=>JSON.parse(c.arguments[1] as string));
 assert.deepEqual(rows.map(r=>r.phase),["requested","requested","rejected","timeout","settled"]);
 for(const row of rows) {
  assert.equal(row.turnId,"original");assert.equal(row.pendingWrite,"other");
  assert.deepEqual(Object.keys(row).sort(),["transportId","turnId","phase","token","pendingWrite"].sort());
 }
 assert.ok(!JSON.stringify(rows).includes("PRIVATE_"));
 assert.equal(turnMetadata(w.turn!).canceled,false);
 assert.ok(!Object.keys(turnMetadata(w.turn!)).includes("stopTokens"));
});
