import test from "node:test";
import assert from "node:assert/strict";
import { Usage } from "../server/usage.ts";
import { provider } from "../server/provider.ts";
import { cliVersion } from "../server/cli-version.ts";

const launch = (code: string, env: Record<string,string> = {}) => ({
  command: process.execPath, args: ["-e", code, "--", "acp"], env,
});
const quota = (reset_time?: string) => ({ status: "SUCCESS", command: { name: "usage", data: {
  groups: [{ name: "Gemini models", buckets: [{ id: "5h", name: "5h", window: "5h",
    remaining_fraction: 0.75, reset_time }] }],
} } });
const print = (value: unknown) => `console.log(${JSON.stringify(JSON.stringify(value))})`;
async function fetchCode(code: string) {
  const s = new Usage().registration();
  const accounts = await s.discover({kind:"global",launch:launch(code)});
  return s.fetch(accounts[0].input);
}
for (const value of [undefined, "1970-01-01T00:00:00Z", "0001-01-01T00:00:00Z", "invalid", "2020-01-01T00:00:00Z"]) {
  test(`usage reset normalization: ${value}`, async () => {
    const r = await fetchCode(print(quota(value)));
    assert.equal(r.status,"available");
    if (r.status !== "available") return;
    assert.equal(r.windows[0].resetsAt, value === "2020-01-01T00:00:00Z" ? value : null);
    assert.equal(r.windows[0].durationSeconds,18000);
  });
}
for (const code of [
  'console.log("PRIVATE_SENTINEL not json")',
  print({status:"PRIVATE_SENTINEL"}),
  print({status:"ERROR",error:"PRIVATE_SENTINEL",response:"PRIVATE_SENTINEL"}),
  print({status:"SUCCESS",command:{name:"PRIVATE_SENTINEL"}}),
  'console.error("PRIVATE_SENTINEL");process.exit(2)',
]) test("usage failures never echo CLI data", async () => {
  await assert.rejects(fetchCode(code), (e: Error) => {
    assert.doesNotMatch(e.message,/PRIVATE_SENTINEL/);
    assert.equal(e.cause,undefined);
    return true;
  });
});

test("session usage merges environment for both query and account identity", async () => {
  const s = new Usage().registration();
  const code = `console.log(process.env.REPORT)`;
  const base = launch(code,{HOME:"/tmp/global-home", REPORT:JSON.stringify(quota())});
  const global = await s.discover({kind:"global",launch:base});
  const session = await s.discover({kind:"session",provider:s.provider!,launch:base,
    env:{HOME:"/tmp/session-home",REPORT:JSON.stringify(quota("2020-01-01T00:00:00Z"))}});
  assert.notEqual(global[0].key,session[0].key);
  const r = await s.fetch(session[0].input);
  assert.equal(r.status,"available");
  if(r.status === "available") assert.equal(r.windows[0].resetsAt,"2020-01-01T00:00:00Z");
});
for (const args of [["--app-data-dir","/tmp/a"],["--gemini-dir=/tmp/b"],
  ["--app_data_dir","/tmp/a"],["--gemini_dir=/tmp/b"],["--cli_dir_name","other-cli"]]) {
  test(`custom ACP directory never queries default account: ${args[0]}`, async () => {
    const s = new Usage().registration(), base = launch(print(quota()));
    const global = await s.discover({kind:"global",launch:base});
    const custom = await s.discover({kind:"global",launch:{...base,args:[...base.args,...args]}});
    assert.notEqual(custom[0].key,global[0].key);
    await assert.rejects(s.fetch(custom[0].input),/custom ACP data directories/);
  });
}

test("installation failure and cancellation have safe diagnostics", async () => {
  const inspect = provider().installation!.inspect!;
  const target = {...launch('console.error("PRIVATE_SENTINEL");process.exit(2)'),resolved:true};
  await assert.rejects(inspect({launch:target,signal:new AbortController().signal}),
    (e: Error) => !e.message.includes("PRIVATE_SENTINEL") && e.cause === undefined);
  const abort = new AbortController(); abort.abort(new Error("PRIVATE_SENTINEL"));
  await assert.rejects(inspect({launch:target,signal:abort.signal}),
    (e: Error) => e.name === "AbortError" && !e.message.includes("PRIVATE_SENTINEL") && e.cause === undefined);
});
for (const [text,version] of [["v1.5.16","1.5.16"],["agy v1.5.16 (build)","1.5.16"],
  ["1.5.15","1.5.15"],["1.5.16.2",undefined],["word1.5.16",undefined],["unknown",undefined]])
  test(`shared version parsing: ${text}`,()=>assert.equal(cliVersion(text!),version));
