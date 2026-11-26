import readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const send = (m) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (u) =>
  send({
    method: "session/update",
    params: { sessionId: "native", update: u },
  });
const ready = () =>
  update({ sessionUpdate: "available_commands_update", availableCommands: [] });
if (process.argv.includes("--version")) {
  if (process.env.SCENARIO === "slow-init")
    await new Promise((resolve) => setTimeout(resolve, 60));
  console.log(process.env.CLI_VERSION ?? "1.5.15");
  process.exit(0);
}
let pending;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line),
    r = (result) => send({ id: m.id, result });
  if (m.method === "initialize") {
    if (process.env.SCENARIO === "login-required") {
      console.log(
        "Open the following link to authenticate https://accounts.google.com/?code=fixture-do-not-show",
      );
      return;
    }
    if (process.env.SCENARIO === "slow-init") {
      setTimeout(
        () =>
          r({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        120,
      );
      return;
    }
    if (process.env.SCENARIO === "init-hang") return;
    if (process.env.SCENARIO === "init-error")
      send({
        id: m.id,
        error: { code: -32603, message: "fixture init failure" },
      });
    else r({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  }
  if (m.method === "session/new") {
    if (process.env.SCENARIO === "new-hang") return;
    if (process.env.SCENARIO === "new-error") {
      console.log("Open the following link to authenticate fixture");
      return;
    }
    r({ sessionId: "native", configOptions: [] });
    setTimeout(ready, 10);
  }
  if (m.method === "session/load") {
    ready();
    if (process.env.SCENARIO === "restore-permissions") {
      for (const id of ["worker-a", "worker-b"]) send({
        id, method: "session/request_permission",
        params: {sessionId:"native",toolCall:{toolCallId:id,title:id,status:"pending"},
          options:[{optionId:"deny",name:"Deny",kind:"reject_once"},{optionId:"yes",name:"Allow",kind:"allow_once"}]}
      });
      r({});
      return;
    }
    if (["restore-text", "restore-text-live"].includes(process.env.SCENARIO)) {
      update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"HISTORY"}});
      r({});
      if (process.env.SCENARIO === "restore-text-live") {
        update({sessionUpdate:"agent_message_chunk",messageId:"",
          content:{type:"text",text:"AUTONOMOUS"}});
      }
      return;
    }
    if (process.env.SCENARIO === "immediate-after-load") {
      const u = update => ({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native",update}});
      process.stdout.write([
        u({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"HIST"}}),
        {jsonrpc:"2.0",id:m.id,result:{}},
        u({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"LIVE_AFTER_LOAD"}}),
        u({sessionUpdate:"tool_call",toolCallId:"live-after-load",title:"live",kind:"execute",status:"completed",rawInput:{}})
      ].map(x => JSON.stringify(x)).join("\n")+"\n");
      return;
    }
    if (process.env.SCENARIO === "live-after-load") {
      r({});
      setTimeout(() => {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "LIVE_AFTER_LOAD" },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "live-after-load",
          title: "live",
          kind: "execute",
          status: "completed",
          rawInput: {},
        });
      }, 260);
      return;
    }
    update({
      sessionUpdate: "tool_call",
      toolCallId: "old-history",
      title: "history",
      kind: "execute",
      status: "in_progress",
      rawInput: {},
    });
    const frame =
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "REPLAY_" + "中".repeat(100000) },
          },
        },
      }) + "\n";
    const bytes = Buffer.from(frame);
    let pos = 0;
    const timer = setInterval(() => {
      const end = Math.min(pos + 50003, bytes.length);
      process.stdout.write(bytes.subarray(pos, end));
      pos = end;
      if (pos === bytes.length) {
        clearInterval(timer);
        r({}); // agy >=1.5.15 finishes history before the response.
      }
    }, 60);
  }
  if (!m.method && ["worker-a", "worker-b"].includes(m.id)) {
    update({sessionUpdate:"agent_message_chunk",messageId:m.id,
      content:{type:"text",text:m.id+":"+m.result.outcome.optionId}});
  }
  if (m.method === "session/close") {
    if (process.env.CLOSE_FILE) writeFileSync(process.env.CLOSE_FILE, "closed");
    r({});
  }
  if (m.method === "session/prompt") {
    const text = m.params.prompt[0].text;
    pending = m.id;
    if (process.env.PROMPTS_FILE) appendFileSync(process.env.PROMPTS_FILE, "prompt\n");
    if (text === "finish-carry")
      update({sessionUpdate:"tool_call_update",toolCallId:"b",status:"completed"});
    if (text.startsWith("turn-")) {
      const mode = text.slice(5), frames = [];
      const u = update => frames.push({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native",update}});
      const say = () => u({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"PRIVATE_ASSISTANT"}});
      const end = () => frames.push({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
      const flush = () => { process.stdout.write(frames.map(f => JSON.stringify(f)).join("\n")+"\n"); frames.length = 0; };
      if (mode === "opening") say();
      for (const id of ["a", "b"]) u({sessionUpdate:"tool_call",toolCallId:id,
        name:mode === "schedule" ? "schedule" : "run_command",title:"PRIVATE_TITLE",
        status:"in_progress",kind:"execute",rawInput:{CommandLine:"PRIVATE_ARGS",
          ...(mode === "daemon" ? {IsDaemon:true} : mode === "schedule" ? {CronExpression:"* * * * *"} : {})}});
      if (mode.startsWith("deferred")) { end(); pending = undefined; flush(); }
      const finish = () => {
        for (const id of ["a", "b"]) {
          if (mode === "deferred-hold" && id === "b") continue;
          u({sessionUpdate:"tool_call_update",toolCallId:id,status:mode === "failed" ? "failed" : "completed",
            rawOutput:"PRIVATE_RESULT"});
          if (mode === "interleaved" && id === "a") say();
        }
        if (["final", "duplicate", "deferred-final"].includes(mode)) say();
        if (mode === "duplicate") u({sessionUpdate:"tool_call_update",toolCallId:"a",status:"completed"});
        // A native ACP usage_update closes the SDK's post-response reply block.
        // This is session protocol coverage, not a plan-quota query.
        if (mode === "deferred-final") u({sessionUpdate:"usage_update",used:1,size:100});
        if (!mode.startsWith("deferred") && mode !== "hold") { end(); pending = undefined; }
        flush();
      };
      if (mode.startsWith("deferred")) setTimeout(finish, 30);
      else finish();
      return;
    }
    if (text === "pending-only") {
      update({ sessionUpdate: "tool_call", toolCallId: "pending-only", title: "pending", status: "pending", kind: "execute", rawInput: {} });
      r({ stopReason: "max_tokens" });
      pending = undefined;
      return;
    }
    if (["content-shell", "content-mcp", "content-diff", "content-native", "content-cleared", "content-read", "content-search", "content-edit"].includes(text)) {
      const shell = ["content-shell", "content-native", "content-cleared"].includes(text), diff = text === "content-diff";
      update({
        sessionUpdate: "tool_call",
        toolCallId: "content-tool",
        name: shell ? "run_command" : (diff || text === "content-edit") ? "edit_file" :
          text === "content-read" ? "read_file" : text === "content-search" ? "search_web" : "mcp_paseo_fixture",
        title: "fixture",
        kind: shell ? "execute" : (diff || text === "content-edit") ? "edit" :
          text === "content-read" ? "read" : text === "content-search" ? "search" : "other",
        status: "in_progress",
        rawInput: shell ? { CommandLine: "printf fixture" } : text === "content-read" ? {Path:"/tmp/read"} :
          text === "content-search" ? {query:"fixture"} : (diff || text === "content-edit") ?
            {Path:"/tmp/edit",Target:"input-before",Replacement:""} : {},
        ...(text === "content-native" ? { rawOutput: { output: "native", exit_code: 0 } } : {}),
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "content-tool",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "partial" } }],
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "content-tool",
        status: "completed",
        content: text === "content-cleared" ? [] : diff
          ? [{ type: "diff", path: "/tmp/fixture", oldText: "before", newText: "after" }]
          : [{ type: "content", content: { type: "text", text: "完整结果\n" } }],
      });
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "background-first") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "bg1",
        title: "background",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "background-follow") {
      setTimeout(() => {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg1",
          status: "completed",
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "DONE" },
        });
        r({ stopReason: "end_turn" });
        pending = undefined;
      }, 450);
      return;
    }
    if (text === "empty") {
      r({ stopReason: "end_turn" });
      pending = undefined;
      return;
    }
    if (text === "silent" || text === "ignore-cancel") return;
    if (text === "exit-17") {
      process.exit(17);
    }
    if (text === "signal-term") {
      process.kill(process.pid, "SIGTERM");
      return;
    }
    if (text === "bad") {
      setTimeout(() => console.log("not ACP"), 20);
      return;
    }
    if (text === "tool" || text === "deferred-bad" || text === "tool-error") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "live",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      });
      if (text === "tool-error") {
        send({
          id: m.id,
          error: { code: -32001, message: "fixture tool failure" },
        });
        pending = undefined;
        return;
      }
      if (text === "deferred-bad") {
        r({ stopReason: "end_turn" });
        setTimeout(() => console.log("not ACP"), 50);
      }
      return;
    }
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OK" },
    });
    r({ stopReason: "end_turn" });
    pending = undefined;
  }
  if (
    m.method === "session/cancel" &&
    process.env.SCENARIO !== "ignore-cancel" &&
    pending !== undefined
  ) {
    send({ id: pending, result: { stopReason: process.env.CANCEL_REASON ?? "cancelled" } });
    pending = undefined;
  }
});
