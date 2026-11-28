import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { provider } from "../server/provider.ts";
import { options } from "../server/vendor.ts";
import type {
  ProviderEvent,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
const config: ProviderSessionConfig = {
  cwd: tmpdir(),
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
};
async function setup(scenario = "", extra: Record<string, string> = {}) {
  const c = await provider({
    checkVersion: async () => "1.5.15",
    limits: { startup: 2000, cancel: 80 },
    closeTimeoutMs: 150,
  }).connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "permission"],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixture.mjs", import.meta.url))],
      env: { PATH: process.env.PATH!, SCENARIO: scenario, ...extra },
    },
  });
  const rows: ProviderEvent[] = [];
  const listeners = new Set<() => void>();
  c.onEvent((e) => {
    rows.push(e);
    for (const f of [...listeners]) f();
  });
  const wait = (p: (e: ProviderEvent) => boolean, from = 0, ms = 3000) =>
    new Promise<ProviderEvent>((resolve, reject) => {
      const done = () => {
        const e = rows.slice(from).find(p);
        if (e) {
          clearTimeout(t);
          listeners.delete(done);
          resolve(e);
        }
      };
      const t = setTimeout(() => {
        listeners.delete(done);
        reject(
          Error(
            "Missing event: " +
              JSON.stringify(rows.slice(from).map((e) => e.type)),
          ),
        );
      }, ms);
      listeners.add(done);
      done();
    });
  const open = async () => {
    await c.send({
      type: "session.open",
      sessionId: "s",
      requestId: "open",
      config,
      history: "skip",
    });
    await wait((e) => e.type === "session.ready");
  };
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
  return { c, rows, wait, open, prompt };
}
for (const mode of ["parallel", "opening", "interleaved", "final", "duplicate", "failed",
  "daemon", "schedule", "deferred", "deferred-final"]) {
  test(`turn-end notice and content-free diagnostics: ${mode}`, {timeout:5000}, async t => {
    // Scale only the SDK's two-minute deferred quiet window, not production policy.
    const defer = options.deferTurnOnRunningTools!;
    const quiet = defer.quietLimitMs;
    defer.quietLimitMs = 60;
    t.after(() => { defer.quietLimitMs = quiet; });
    const log = t.mock.method(console, "log", () => {});
    const h = await setup();
    try {
      await h.open();
      const from = await h.prompt(`turn-${mode}`);
      await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
      const rows = h.rows.slice(from), notices = rows.filter(e => e.type === "session.notice");
      const expected = ["parallel", "opening", "interleaved", "failed", "deferred"].includes(mode);
      assert.equal(notices.length, expected ? 1 : 0);
      if (expected) {
        const e = notices[0];
        assert.ok(e.type === "session.notice");
        assert.equal(e.notice.id, "antigravity-tool-only");
        assert.equal(e.notice.severity, "info");
        assert.equal(e.notice.title.includes("failed"), mode === "failed");
        assert.ok(rows.indexOf(e) < rows.findIndex(e => e.type === "session.turn" && e.state === "completed"));
      }
      const records = log.mock.calls.map(c => c.arguments);
      assert.deepEqual(records.map(r => r[0]), ["[antigravity:prompt-end]", "[antigravity:turn-end]"]);
      const end = JSON.parse(records[1][1] as string);
      assert.equal(end.state, "completed");
      assert.equal(end.stopReason, "end_turn");
      assert.equal(end.results, 2);
      assert.equal(end.failed, mode === "failed" ? 2 : 0);
      assert.equal(end.completed, ["failed", "daemon", "schedule"].includes(mode) ? 0 : 2);
      assert.ok(!JSON.stringify(records).includes("PRIVATE_"));
      assert.ok(!JSON.stringify(records).includes(`turn-${mode}`));
    } finally { await h.c.close(); }
  });
}
for (const reason of ["cancelled", "end_turn"])
for (const action of ["replace", "interrupt", "deferred-replace"]) {
  test(`turn-end suppresses notices on ${action} (${reason})`, {timeout:5000}, async t => {
    const log = t.mock.method(console, "log", () => {});
    const dir = await mkdtemp(join(tmpdir(), "agy-prompts-")), file = join(dir, "count");
    const h = await setup("", {CANCEL_REASON:reason, PROMPTS_FILE:file});
    try {
      await h.open();
      const from = await h.prompt(action === "deferred-replace" ? "turn-deferred-hold" : "turn-hold");
      const started = await h.wait(e => e.type === "session.turn" && e.state === "started", from);
      assert.ok(started.type === "session.turn");
      await h.wait(e => e.type === "timeline.item" && e.item.type === "tool_call" &&
        e.item.callId === "a" && e.item.status === "completed", from);
      if (action === "interrupt")
        await h.c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
      else await h.prompt(action === "deferred-replace" ? "finish-carry" : "hello");
      await h.wait(e => e.type === "session.turn" && e.state !== "started" && e.turnId === started.turnId, from);
      if (action !== "interrupt")
        await h.wait(e => e.type === "session.turn" && e.state === "completed" && e.turnId !== started.turnId, from);
      assert.equal(h.rows.slice(from).filter(e => e.type === "session.notice").length, 0);
      assert.equal((await readFile(file, "utf8")).trim().split("\n").length, action === "interrupt" ? 1 : 2);
      const end = JSON.parse(log.mock.calls.find(c => c.arguments[0] === "[antigravity:turn-end]")!.arguments[1] as string);
      assert.equal(end.replaced, action !== "interrupt");
      assert.equal(end.canceled, action !== "deferred-replace");
    } finally { await h.c.close(); await rm(dir, {recursive:true,force:true}); }
  });
}
test("rejected replacement cannot hide the original turn notice", {timeout:5000}, async t => {
  const defer = options.deferTurnOnRunningTools!, quiet = defer.quietLimitMs;
  defer.quietLimitMs = 100;
  t.after(() => { defer.quietLimitMs = quiet; });
  const h = await setup();
  try {
    await h.open();
    const from = await h.prompt("turn-deferred");
    await h.wait(e => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed", from);
    await assert.rejects(h.c.send({type:"session.prompt",sessionId:"s",prompt:{
      clientMessageId:"invalid",delivery:"auto",input:{type:"not-a-prompt"} as never,
    }}));
    await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
    assert.equal(h.rows.slice(from).filter(e => e.type === "session.notice" && e.notice.id === "antigravity-tool-only").length,1);
  } finally { await h.c.close(); }
});

test("rapid replacements preserve final empty notice and suppress earlier notices", {timeout:6000}, async () => {
  const h = await setup();
  try {
    await h.open();
    const from = await h.prompt("turn-deferred-hold");
    await h.wait(e => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed", from);
    await Promise.all([h.prompt("turn-deferred-hold"), h.prompt("empty")]);
    await h.wait(e => e.type === "session.notice" && e.notice.id === "antigravity-empty", from);
    const notices = h.rows.slice(from).filter(e => e.type === "session.notice");
    assert.equal(notices.length,1);
  } finally { await h.c.close(); }
});

test("accepted queued prompts fail asynchronously on close without poisoning reopen", {timeout:6000}, async () => {
  const h = await setup("ignore-cancel");
  try {
    await h.open();
    const from = await h.prompt("silent");
    await h.wait(e => e.type === "session.turn" && e.state === "started", from);
    for (const id of ["queued-2", "queued-3"]) {
      // These are valid, admitted prompts, not schema/admission rejections.
      await h.c.send({type:"session.prompt",sessionId:"s",prompt:{
        clientMessageId:id,delivery:"auto",input:{type:"message",content:[{type:"text",text:"empty"}]},
      }});
    }
    await h.c.send({type:"session.close",sessionId:"s",requestId:"close-queued"});
    await h.wait(e => e.type === "session.closed", from);
    for (const id of ["queued-2", "queued-3"]) {
      const result = await h.wait(e => e.type === "session.prompt_result" && e.clientMessageId === id, from);
      assert.ok(result.type === "session.prompt_result");
      assert.equal(result.result.type,"failed");
      assert.equal(h.rows.slice(from).filter(e => e.type === "session.prompt_result" && e.clientMessageId === id).length,1);
    }
    const reopened = h.rows.length;
    await h.c.send({type:"session.open",sessionId:"s",requestId:"reopen",config,history:"skip"});
    await h.wait(e => e.type === "session.ready", reopened);
    const empty = await h.prompt("empty");
    await h.wait(e => e.type === "session.turn" && e.state === "completed", empty);
    assert.equal(h.rows.slice(empty).filter(e => e.type === "session.notice" && e.notice.id === "antigravity-empty").length,1);
  } finally { await h.c.close(); }
});

for (const scenario of ["", "ignore-cancel"]) {
  test(`quiet prompt remains open until explicit Stop (${scenario || "responsive"})`, {timeout:5000}, async () => {
    const h = await setup(scenario);
    try {
      await h.open();
      const from = await h.prompt("silent");
      await h.wait(e => e.type === "session.turn" && e.state === "started", from);
      // Beyond the former scaled 200ms silent deadline; no heartbeat is sent.
      await sleep(350);
      assert.ok(!h.rows.slice(from).some(e => e.type === "session.runtime_failed" ||
        (e.type === "session.turn" && e.state !== "started")));
      await h.c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
      if (scenario) {
        const e = await h.wait(e => e.type === "session.runtime_failed", from);
        assert.ok(e.type === "session.runtime_failed");
        assert.match(e.error.message, /cancel/i);
      } else await h.wait(e => e.type === "session.turn" && e.state === "canceled", from);
    } finally { await h.c.close(); }
  });
}

for (const [text, reason] of [
  ["bad", "non-ACP"],
  ["deferred-bad", "non-ACP"],
  ["exit-17", "exit code 17"],
  ["signal-term", "SIGTERM"],
] as const) {
  test(
    `SDK delivers specific runtime and turn failure: ${text}`,
    { timeout: 5000 },
    async () => {
      const h = await setup();
      try {
        await h.open();
        const from = await h.prompt(text);
        const runtime = await h.wait(
          (e) => e.type === "session.runtime_failed",
          from,
        );
        assert.ok(
          runtime.type === "session.runtime_failed" &&
            runtime.error.message.includes(reason),
        );
        const turn = await h.wait(
          (e) => e.type === "session.turn" && e.state === "failed",
          from,
        );
        assert.ok(
          turn.type === "session.turn" &&
            turn.state === "failed" &&
            turn.error?.message.includes(reason),
          JSON.stringify(turn),
        );
        assert.ok(!h.rows.slice(from).some((e) => e.type === "session.notice"));
      } finally {
        await h.c.close();
      }
    },
  );
}
for (const kind of ["shell", "mcp", "diff", "native", "cleared", "read", "search", "edit"]) {
  test(`SDK preserves content-only ${kind} results without empty-result warnings`, { timeout: 5000 }, async () => {
    const h = await setup();
    try {
      await h.open();
      const from = await h.prompt(`content-${kind}`);
      await h.wait((e) => e.type === "session.turn" && e.state === "completed", from);
      const result = h.rows.slice(from).find(
        (e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed",
      );
      assert.ok(result?.type === "timeline.item" && result.item.type === "tool_call");
      const detail = result.item.detail;
      if (kind === "native" || kind === "cleared") {
        assert.ok(detail.type === "shell");
        assert.equal(detail.output, kind === "native" ? "native" : undefined);
        assert.equal(detail.exitCode, kind === "native" ? 0 : undefined);
      } else if (kind === "shell") {
        assert.ok(detail.type === "shell");
        assert.equal(detail.output, "完整结果\n");
      } else if (kind === "mcp") {
        assert.ok(detail.type === "unknown");
        assert.equal(detail.output, "完整结果\n");
      } else if (kind === "read" || kind === "search") {
        assert.equal(detail.type, kind);
        assert.ok(detail.type === "read" || detail.type === "search");
        assert.equal(detail.content, "完整结果\n");
      } else {
        assert.ok(detail.type === "edit");
        assert.equal(detail.oldString, kind === "diff" ? "before" : "input-before");
        assert.equal(detail.newString, kind === "diff" ? "after" : "");
        assert.equal(detail.filePath, kind === "diff" ? "/tmp/fixture" : "/tmp/edit");
      }
      assert.ok(!h.rows.slice(from).some(
        (e) => e.type === "session.notice" && e.notice.id === "antigravity-empty",
      ));
      const next = await h.prompt("empty");
      await h.wait((e) => e.type === "session.turn" && e.state === "completed", next);
      assert.ok(h.rows.slice(next).some(
        (e) => e.type === "session.notice" && e.notice.id === "antigravity-empty",
      ), "a previous tool result must not hide a later empty turn");
    } finally {
      await h.c.close();
    }
  });
}
for (const replay of [false, true]) {
  test(`synthetic tool completion cannot hide empty output (replay=${replay})`, { timeout: 6000 }, async () => {
    const h = await setup();
    try {
      await h.open();
      if (replay) {
        const opened = h.rows.find(e => e.type === "session.opened");
        assert.ok(opened?.type === "session.opened");
        await h.c.send({ type: "session.close", sessionId: "s", requestId: "close" });
        await h.wait(e => e.type === "session.closed");
        const from = h.rows.length;
        await h.c.send({ type: "session.open", sessionId: "s", requestId: "restore", config,
          history: "replay", persistence: opened.persistence });
        await h.wait(e => e.type === "session.ready", from);
      }
      const from = await h.prompt(replay ? "empty" : "pending-only");
      await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
      assert.ok(h.rows.slice(from).some(e => e.type === "session.notice" && e.notice.id === "antigravity-empty"));
    } finally { await h.c.close(); }
  });
}
test(
  "SDK idle and long-running tool waits emit no notices or failures",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      await sleep(350);
      const from = await h.prompt("tool");
      await h.wait(
        (e) => e.type === "timeline.item" && e.item.type === "tool_call",
        from,
      );
      await sleep(350);
      assert.ok(
        !h.rows.some(
          (e) => e.type === "session.notice" || e.type === "session.runtime_failed",
        ),
      );
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK cancellation clears a tool with no terminal update",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("tool");
      await h.wait(
        (e) => e.type === "timeline.item" && e.item.type === "tool_call",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "stop",
      });
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "canceled",
        from,
      );
      from = await h.prompt("hello");
      await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
      assert.ok(!h.rows.slice(from).some(e => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "0.2.2 SDK terminalizes failed RPC tools without poisoning the next turn",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("tool-error");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "failed",
        from,
      );
      assert.ok(
        h.rows
          .slice(from)
          .some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "tool_call" &&
              e.item.status === "failed",
          ),
      );
      from = await h.prompt("hello");
      await h.wait(e => e.type === "session.turn" && e.state === "completed", from);
      assert.ok(!h.rows.slice(from).some(e => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK close callers share the same bounded cleanup",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    await h.open();
    const a = h.c.close(),
      b = h.c.close();
    assert.equal(a, b);
    await Promise.all([a, b]);
  },
);
test(
  "SDK cancel timeout keeps its concrete reason",
  { timeout: 5000 },
  async () => {
    const h = await setup("ignore-cancel");
    try {
      await h.open();
      const from = await h.prompt("ignore-cancel");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "started",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "stop",
      });
      const e = await h.wait((e) => e.type === "session.runtime_failed", from);
      assert.ok(
        e.type === "session.runtime_failed" &&
          e.error.message.includes("cancel request"),
      );
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK cancel after completed turn does not kill next real turn",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      let from = await h.prompt("hello");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      await h.c.send({
        type: "session.interrupt",
        sessionId: "s",
        requestId: "idle-stop",
      });
      await sleep(120);
      from = await h.prompt("hello again");
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(!h.rows.some((e) => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK restored history survives >200ms partial UTF8 frames and ghost tool",
  { timeout: 6000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      const opened = h.rows.find((e) => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");
      await h.c.send({
        type: "session.close",
        sessionId: "s",
        requestId: "close",
      });
      await h.wait((e) => e.type === "session.closed");
      const from = h.rows.length;
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "restore",
        config,
        history: "replay",
        persistence: opened.persistence,
      });
      await h.wait((e) => e.type === "session.ready", from);
      assert.ok(
        h.rows
          .slice(from)
          .some(
            (e) =>
              e.type === "timeline.item" &&
              e.item.type === "assistant_message" &&
              e.item.text === "REPLAY_" + "中".repeat(100000),
          ),
      );
      const p = await h.prompt("hello");
      await h.wait(e => e.type === "session.turn" && e.state === "completed", p);
      assert.ok(!h.rows.slice(p).some(e => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
for (const history of ["skip", "replay"] as const)
  test(`Stop closes restored approvals without an active turn (${history})`, {timeout:6000}, async () => {
    const h = await setup("restore-permissions");
    try {
      await h.open();
      const opened = h.rows.find(e => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");
      await h.c.send({type:"session.close",sessionId:"s",requestId:"close"});
      await h.wait(e => e.type === "session.closed");
      const from = h.rows.length;
      await h.c.send({type:"session.open",sessionId:"s",requestId:"restore",config,history,persistence:opened.persistence});
      await h.wait(e => e.type === "session.ready",from);
      await h.wait(e => e.type === "session.permission" && e.request.title === "worker-b",from);
      await h.c.send({type:"session.interrupt",sessionId:"s",requestId:"stop"});
      const failure = await h.wait(e => e.type === "session.runtime_failed",from);
      assert.ok(failure.type === "session.runtime_failed");
      assert.match(failure.error.message, /cancel/i);
      // SDK settlePendingWork resolves permission promises on transport failure,
      // but 0.17.3 emits no permission_resolved events here. runtime_failed is
      // the host cleanup boundary; UI dismissal needs separate host validation.
      assert.equal(h.rows.slice(from).filter(e => e.type === "session.turn").length,0);
      assert.equal(h.rows.slice(from).filter(e => e.type === "session.permission").length,2);
    } finally { await h.c.close(); }
  });

for (const history of ["skip", "replay"] as const)
  test(`restored concurrent subagent approvals route independently (${history})`, {timeout:6000}, async () => {
    const h = await setup("restore-permissions");
    try {
      await h.open();
      const opened = h.rows.find(e => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");
      await h.c.send({type:"session.close",sessionId:"s",requestId:"close"});
      await h.wait(e => e.type === "session.closed");
      const from = h.rows.length;
      await h.c.send({type:"session.open",sessionId:"s",requestId:"restore",config,history,persistence:opened.persistence});
      await h.wait(e => e.type === "session.ready",from);
      // Answer in reverse order, without sending a prompt after restoration.
      for (const [name, action] of [["worker-b","deny"],["worker-a","yes"]]) {
        const e = await h.wait(e => e.type === "session.permission" && e.request.title === name,from);
        assert.ok(e.type === "session.permission");
        assert.deepEqual(e.request.actions?.map(a => a.id), ["deny","yes"]);
        await h.c.send({type:"session.permission",sessionId:"s",permissionId:e.request.id,
          response:{behavior:action === "yes" ? "allow" : "deny",selectedActionId:action}});
        await h.wait(e => e.type === "timeline.item" && e.item.type === "assistant_message" &&
          e.item.text === name+":"+action,from);
      }
      assert.equal(h.rows.slice(from).filter(e => e.type === "session.permission_resolved").length,2);
    } finally { await h.c.close(); }
  });

for (const history of ["skip", "replay"] as const)
for (const scenario of ["restore-text", "restore-text-live"])
  test(`restored pure-text replies stay separate across prompts (${history}, ${scenario})`, {timeout:6000}, async () => {
    const h = await setup(scenario);
    try {
      await h.open();
      const opened = h.rows.find(e => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");
      await h.c.send({type:"session.close",sessionId:"s",requestId:"close"});
      await h.wait(e => e.type === "session.closed");
      const restored = h.rows.length;
      await h.c.send({type:"session.open",sessionId:"s",requestId:"restore",
        config,history,persistence:opened.persistence});
      await h.wait(e => e.type === "session.ready",restored);
      if (scenario === "restore-text-live")
        await h.wait(e => e.type === "timeline.item" && e.item.type === "assistant_message" &&
          e.item.text === "AUTONOMOUS",restored);
      const ids = [];
      for (const text of ["ONE","TWO"]) {
        const from = await h.prompt(text);
        await h.wait(e => e.type === "session.turn" && e.state === "completed",from);
        const reply = h.rows.slice(from).find(e => e.type === "timeline.item" && e.item.type === "assistant_message");
        assert.ok(reply?.type === "timeline.item" && reply.item.type === "assistant_message");
        assert.equal(reply.item.text,"OK");
        assert.ok(!reply.item.messageId?.startsWith("paseo-live:"));
        ids.push(reply.item.id);
      }
      assert.notEqual(ids[0],ids[1]);
    } finally { await h.c.close(); }
  });

for (const history of ["skip", "replay"] as const)
for (const scenario of ["live-after-load", "immediate-after-load"])
  test(
    `live output after load is visible without a new prompt (${history}, ${scenario})`,
    { timeout: 6000 },
    async () => {
      const h = await setup(scenario);
      try {
        await h.open();
        const opened = h.rows.find((e) => e.type === "session.opened");
        assert.ok(opened?.type === "session.opened");
        await h.c.send({
          type: "session.close",
          sessionId: "s",
          requestId: "close",
        });
        await h.wait((e) => e.type === "session.closed");
        const from = h.rows.length;
        await h.c.send({
          type: "session.open",
          sessionId: "s",
          requestId: "restore",
          config,
          history,
          persistence: opened.persistence,
        });
        await h.wait((e) => e.type === "session.ready", from);
        await sleep(350);
        for (const kind of ["assistant_message", "tool_call"]) {
          assert.ok(h.rows.slice(from).some(e => e.type === "timeline.item" &&
            e.item.type === kind && (e.item.type === "assistant_message"
              ? e.item.text === "LIVE_AFTER_LOAD"
              : e.item.type === "tool_call" && e.item.callId === "live-after-load")));
        }
        const p = await h.prompt("hello");
        await h.wait(
          (e) => e.type === "session.turn" && e.state === "completed",
          p,
        );
      } finally {
        await h.c.close();
      }
    },
  );
test(
  "0.2.2 auto followup retains background tool until its real terminal event",
  { timeout: 5000 },
  async () => {
    const h = await setup();
    try {
      await h.open();
      await h.prompt("background-first");
      await sleep(80);
      const from = await h.prompt("background-follow");
      await h.wait(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text === "DONE",
        from,
      );
      await h.wait(
        (e) => e.type === "session.turn" && e.state === "completed",
        from,
      );
      assert.ok(!h.rows.some((e) => e.type === "session.runtime_failed"));
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK graceful close sends session/close before terminating CLI",
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-close-"));
    const file = join(dir, "close");
    const h = await setup("", { CLOSE_FILE: file });
    try {
      await h.open();
      await h.c.close();
      assert.equal(await readFile(file, "utf8"), "closed");
    } finally {
      await h.c.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "SDK close stays bounded even with session/new in flight",
  { timeout: 5000 },
  async () => {
    const h = await setup("new-hang");
    try {
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "open",
        config,
        history: "skip",
      });
      await sleep(50);
      const at = Date.now();
      await h.c.close();
      assert.ok(Date.now() - at < 1500);
    } finally {
      await h.c.close();
    }
  },
);
test(
  "SDK session/new failure retains login diagnostic",
  { timeout: 5000 },
  async () => {
    const h = await setup("new-error");
    try {
      await h.c.send({
        type: "session.open",
        sessionId: "s",
        requestId: "open",
        config,
        history: "skip",
      });
      const e = await h.wait((e) => e.type === "request.failed");
      assert.ok(
        e.type === "request.failed" && e.error.message.includes("sign-in"),
      );
    } finally {
      await h.c.close();
    }
  },
);
