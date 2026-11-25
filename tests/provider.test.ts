import test from "node:test";
import assert from "node:assert/strict";
import { provider } from "../server/provider.ts";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

const mock = String.raw`
const rl=require('node:readline');let permission;
const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
rl.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),r=result=>send({id:m.id,result});
if(m.method==='initialize')r({protocolVersion:1,agentCapabilities:{loadSession:true}});
if(m.method==='session/new')r({sessionId:'native',configOptions:[]});
if(m.method==='session/load'||m.method==='session/close')r({});
if(m.method==='session/prompt'){
const text=m.params.prompt[0].text;
if(text.startsWith('permission')){
permission=m.id;
const edit=text!=='permission', diff=text==='permission-edit-diff';
send({id:'allow',method:'session/request_permission',params:{sessionId:'native',toolCall:{
  toolCallId:text,title:'fixture tool',status:'pending',
  ...(edit?{name:'edit_file',kind:'edit',rawInput:{Path:'/tmp/input',Target:'input-before',Replacement:''}}:{}),
  content:diff?[{type:'diff',path:'/tmp/native',oldText:'native-before',newText:'native-after'}]:
    [{type:'content',content:{type:'text',text:'approval explanation'}}]
},options:[{optionId:'deny',name:'Deny',kind:'reject_once'},{optionId:'yes',name:'Allow',kind:'allow_once'}]}});return;}
if(text==='empty'){r({stopReason:'end_turn'});return;}
send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.env.FIXTURE_SESSION_VALUE??'none'}}}});r({stopReason:'end_turn'});}
if(m.id==='allow'&&!m.method)send({id:permission,result:{stopReason:'cancelled'}});
});`;

test(
  "real SDK honors session env, streams, permissions, empty-result notice and reload",
  { timeout: 15000 },
  async () => {
    const c = await provider({ checkVersion: async () => "1.5.15" }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence", "permission"],
      launch: {
        command: process.execPath,
        args: ["-e", mock],
        env: { PATH: process.env.PATH! },
      },
    });
    const rows: ProviderEvent[] = [],
      listeners = new Set<() => void>();
    c.onEvent((e) => {
      rows.push(e);
      for (const f of [...listeners]) f();
    });
    const wait = (p: (e: ProviderEvent) => boolean, from = 0) =>
      new Promise<ProviderEvent>((resolve, reject) => {
        const check = () => {
          const e = rows.slice(from).find(p);
          if (e) {
            clearTimeout(t);
            listeners.delete(check);
            resolve(e);
          }
        };
        const t = setTimeout(() => {
          listeners.delete(check);
          reject(
            Error("missing SDK event: " + JSON.stringify(rows.slice(from))),
          );
        }, 3000);
        listeners.add(check);
        check();
      });
    const config = {
      cwd: "/tmp",
      env: { FIXTURE_SESSION_VALUE: "session-preserved" },
      mcpServers: {},
      settings: {},
      persist: true,
    };
    try {
      await c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "open",
        history: "skip",
        config,
      });
      const opened = await wait((e) => e.type === "session.opened");
      await wait((e) => e.type === "session.ready");
      const prompt = async (text: string) => {
        const from = rows.length;
        await c.send({
          type: "session.prompt",
          sessionId: "s",
          prompt: {
            clientMessageId: crypto.randomUUID(),
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text }] },
          },
        });
        return from;
      };
      let from = await prompt("hello");
      await wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(
        rows
          .slice(from)
          .some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "assistant_message" &&
              e.item.text === "session-preserved",
          ),
      );
      from = await prompt("permission");
      const permission = await wait(
        (e) => e.type === "session.permission",
        from,
      );
      assert.equal(permission.type, "session.permission");
      if (permission.type === "session.permission" && process.env.SDK_PERMISSION_DETAILS === "1") {
        const detail = (permission.request as {detail?: {type:string; text?:string}}).detail;
        assert.equal(detail?.type, "plain_text");
        assert.equal(detail?.text, "approval explanation");
      }
      if (permission.type === "session.permission")
        await c.send({
          type: "session.permission",
          sessionId: "s",
          permissionId: permission.request.id,
          response: { behavior: "deny", selectedActionId: "deny" },
        });
      await wait(
        (e) => e.type === "session.turn" && e.state === "canceled",
        from,
      );
      for (const name of ["permission-edit", "permission-edit-diff"]) {
        from = await prompt(name);
        const approval = await wait(e => e.type === "session.permission", from);
        assert.ok(approval.type === "session.permission");
        if (process.env.SDK_PERMISSION_DETAILS === "1") {
          const detail = (approval.request as {detail?: {type:string; filePath?:string; oldString?:string; newString?:string}}).detail;
          assert.equal(detail?.type,"edit");
          const native = name.endsWith("-diff");
          assert.equal(detail?.filePath,native ? "/tmp/native" : "/tmp/input");
          assert.equal(detail?.oldString,native ? "native-before" : "input-before");
          assert.equal(detail?.newString,native ? "native-after" : "");
        }
        await c.send({type:"session.permission",sessionId:"s",permissionId:approval.request.id,
          response:{behavior:"deny",selectedActionId:"deny"}});
        await wait(e => e.type === "session.turn" && e.state === "canceled", from);
      }
      from = await prompt("empty");
      await wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(
        rows
          .slice(from)
          .some(
            (e) =>
              e.type === "session.notice" &&
              e.notice.id === "antigravity-empty",
          ),
      );
      await c.send({
        type: "session.close",
        requestId: "close",
        sessionId: "s",
      });
      await wait((e) => e.type === "session.closed");
      assert.equal(opened.type, "session.opened");
      if (opened.type === "session.opened")
        await c.send({
          type: "session.open",
          sessionId: "r",
          requestId: "restore",
          history: "replay",
          config,
          persistence: opened.persistence,
        });
      await wait((e) => e.type === "session.ready" && e.sessionId === "r");
    } finally {
      await c.close();
    }
  },
);
test("missing CLI is not reported available", async () => {
  assert.equal(
    (
      await provider().status!({
        launch: { command: "/nonexistent/agy", args: ["acp"], env: {} },
      })
    ).available,
    false,
  );
});
