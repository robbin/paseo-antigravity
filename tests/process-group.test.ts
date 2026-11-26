import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { stopGroup, stopProcessGroup } from "../server/process-group.ts";
const err = (code: string) => Object.assign(new Error(code), { code });

for (const jump of [-60_000, 60_000]) {
  test(`owned process cleanup ignores wall-clock jump ${jump}`, async t => {
    let clockReads = 0, ticks = 0, probes = 0;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    t.mock.method(Date, "now", () => 100_000 + (clockReads++ ? jump : 0));
    t.mock.method(performance, "now", () => ticks++ * 20);
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -12345);
      signals.push(signal);
      // Bound the pre-fix rollback case; no real process receives a signal.
      if (signal === 0 && ++probes > 10) throw err("EIO");
      return true;
    });
    assert.equal(await stopProcessGroup(12345, 60), undefined);
    assert.deepEqual(signals, ["SIGTERM", 0, 0, "SIGKILL"]);
  });
}
test("ESRCH after EPERM retry is success, never signals a vanished group again", async () => {
  let calls = 0,
    now = 0;
  const result = await stopGroup({
    signal() {
      calls++;
      throw err(calls === 1 ? "EPERM" : "ESRCH");
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
  assert.equal(result, undefined);
  assert.equal(calls, 2);
});
test("persistent EPERM is bounded, tries force-stop and reports failure", async () => {
  const calls: Array<string | number> = [];
  let now = 0;
  const result = await stopGroup({
    signal(s) {
      calls.push(s);
      throw err("EPERM");
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
  assert.ok(result);
  assert.ok(calls.includes("SIGKILL"));
  assert.ok(now < 1500);
});
test("graceful failure still attempts SIGKILL; successful termination stops probing", async () => {
  const calls: Array<string | number> = [];
  let now = 0;
  const result = await stopGroup(
    {
      signal(s) {
        calls.push(s);
        if (s === "SIGTERM") throw err("EIO");
        if (s === "SIGKILL") throw err("ESRCH");
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    },
    100,
  );
  assert.equal(result, undefined);
  assert.ok(calls.includes("SIGKILL"));
});
