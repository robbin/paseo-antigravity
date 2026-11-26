import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { provider } from "../server/provider.ts";
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const launch = (scenario = "") => ({
  command: process.execPath,
  args: [fixture, "acp"],
  env: { SCENARIO: scenario, SSH_TTY: "fixture" },
});
test("status validates ACP handshake, not just executable version", async () => {
  const p = provider();
  const good = await p.status!({ launch: launch() });
  assert.equal(good.available, true);
  assert.match(good.diagnostic!, /SSH_TTY/);
  assert.equal(
    (await p.status!({ launch: launch("init-error") })).available,
    false,
  );
});
test("status retains safe login diagnostic without printing authorization URL", async () => {
  const result = await provider().status!({ launch: launch("login-required") });
  assert.equal(result.available, false);
  assert.match(result.diagnostic!, /登录/);
  assert.doesNotMatch(
    result.diagnostic!,
    /accounts\.google|fixture-do-not-show/,
  );
});
test("status uses one cold-start budget for version and handshake", async () => {
  const result = await provider({ statusTimeoutMs: 1000 }).status!({
    launch: launch("slow-init"),
  });
  assert.equal(result.available, true);
});
test("status timeout remains bounded and reports the failed phase", async () => {
  const at = Date.now();
  const result = await provider({ statusTimeoutMs: 150 }).status!({
    launch: launch("init-hang"),
  });
  assert.equal(result.available, false);
  assert.match(result.diagnostic!, /ACP|initialize/);
  assert.ok(Date.now() - at < 2000);
});
test("installation inspect preserves custom prefix without acp", async () => {
  const p = provider();
  const result = await p.installation!.inspect!({
    launch: { ...launch(), args: [fixture], resolved: true },
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "installed");
  if (result.status === "installed") assert.equal(result.version, "1.5.15");
});
