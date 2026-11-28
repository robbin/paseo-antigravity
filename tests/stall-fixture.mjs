import readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const scenario = process.env.STALL_SCENARIO;
const send = message => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\n");
const update = update => send({method: "session/update", params: {sessionId: "native", update}});
const text = (text, thought = false) => update({sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk", content: {type: "text", text}});
const tool = extra => update({sessionUpdate: "tool_call", toolCallId: "job", title: "job", kind: "execute", rawInput: {}, status: "completed", ...extra});
const background = kind => tool(kind === "background" ? {name: "run_command", rawOutput: "Tool is running as a background task; task id: PRIVATE_JOB"} :
  kind === "daemon" ? {name: "run_command", rawInput: {IsDaemon: true}} :
  kind === "cron" ? {name: "schedule", rawInput: {CronExpression: "* * * * *"}} :
  {name: kind === "subagent" ? "invoke_subagent" : "schedule"});
let pending, prompts = 0;
readline.createInterface({input: process.stdin}).on("line", line => {
  const m = JSON.parse(line), reply = result => send({id: m.id, result});
  if (process.env.TRACE_FILE && ["session/prompt", "session/cancel"].includes(m.method))
    appendFileSync(process.env.TRACE_FILE, JSON.stringify({method: m.method, text: m.params.prompt?.[0]?.text}) + "\n");
  if (m.method === "initialize") reply({protocolVersion: 1, agentCapabilities: {loadSession: true}});
  if (m.method === "session/new" || m.method === "session/load") {
    if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
    if (scenario === "ignore") process.on("SIGTERM", () => {});
    if (m.method === "session/load" && scenario.startsWith("history-")) background(scenario.slice(8));
    reply(m.method === "session/new" ? {sessionId: "native", configOptions: [],
      ...(scenario === "slow-config" ? {modes: {currentModeId: "default", availableModes: [{id: "default", name: "Default"}, {id: "other", name: "Other"}]}} : {})} : {});
    update({sessionUpdate: "available_commands_update", availableCommands: []});
    if (scenario === "blocked-write") {
      process.stdin.pause();
      setInterval(() => {}, 1000);
    }
  }
  if (m.method === "session/close") reply({});
  if (m.method === "session/set_mode") setTimeout(() => reply({}), 350);
  if (m.method === "session/prompt") {
    pending = m.id;
    prompts++;
    const input = m.params.prompt[0].text;
    const finish = () => {text("RECOVERED"); reply({stopReason: "end_turn"}); pending = undefined;};
    if (input === "user-next" || (prompts > 1 && scenario !== "repeat" &&
        !(scenario.startsWith("scope-") && prompts === 2))) {finish(); return;}
    if (scenario.startsWith("scope-") && prompts === 1) {
      background(scenario.slice(6));
      // agy completes these jobs via an independent callback, not a same-call
      // numeric exit_code update. Leave the launcher row untouched.
      setTimeout(() => {
        update({sessionUpdate: "user_message_chunk", content: {type: "text", text: "<SYSTEM_MESSAGE>background callback</SYSTEM_MESSAGE>"}});
        finish();
      }, 400);
      return;
    }
    if (scenario === "short") {setTimeout(finish, 40); return;}
    if (scenario === "stream") {
      let count = 0;
      const timer = setInterval(() => {text("thinking", ++count % 2 === 1); if (count === 12) {clearInterval(timer); finish();}}, 30);
      return;
    }
    if (scenario === "foreground") {tool({status: "in_progress", name: "run_command"}); return;}
    if (scenario === "approval") {
      send({id: "permission", method: "session/request_permission", params: {sessionId: "native", toolCall: {toolCallId: "permission", title: "approval", status: "pending", rawInput: {}}, options: [{optionId: "yes", name: "Allow", kind: "allow_once"}]}});
      return;
    }
    if (scenario === "background") {tool({name: "run_command", rawOutput: "Tool is running as a background task; task id: PRIVATE_JOB"}); return;}
    if (scenario === "daemon") {tool({name: "run_command", rawInput: {IsDaemon: true}}); return;}
    if (scenario === "subagent" || scenario === "schedule") {tool({name: scenario === "subagent" ? "invoke_subagent" : "schedule"}); return;}
    if (scenario === "tool-recover") tool({name: "run_command", rawOutput: {exit_code: 0, output: "PRIVATE_RESULT"}});
    else text("PRIVATE_THOUGHT", true);
  }
  if (m.method === "session/cancel" && pending !== undefined && scenario !== "ignore") {
    const id = pending;
    const cancel = () => {
      if (pending !== id) return;
      pending = undefined;
      if (scenario === "late-background") tool({name: "invoke_subagent"});
      if (scenario === "cancel-error") send({id, error: {code: -32001, message: "fixture failure"}});
      else send({id, result: {stopReason: scenario === "end-turn" ? "end_turn" : "cancelled"}});
      if (scenario === "crash-cancel") process.stdout.write("", () => process.exit(17));
    };
    if (scenario === "slow-cancel") setTimeout(cancel, 100);
    else cancel();
  }
});
