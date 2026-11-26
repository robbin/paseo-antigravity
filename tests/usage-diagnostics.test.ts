import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Usage } from "../server/usage.ts";

// Synthetic privacy sentinels, never real account data or authorization links.
const privateDetail = "PRIVATE_SENTINEL fixture@example.com https://example.invalid/auth?code=PRIVATE_SENTINEL";
const eligibility = "Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.";

async function fetchCode(code: string, command = process.execPath) {
  const source = new Usage().registration();
  const [account] = await source.discover({
    kind: "global",
    launch: { command, args: ["-e", code, "--", "acp"], env: {} },
  });
  return source.fetch(account!.input);
}

function output(data: unknown, exit = 1) {
  return `console.log(${JSON.stringify(JSON.stringify(data))});process.exitCode=${exit}`;
}

async function rejectsSafely(promise: Promise<unknown>, expected: RegExp) {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|fixture@|example\.invalid/);
    assert.equal(error.cause, undefined);
    assert.equal("stdout" in error, false);
    assert.equal("stderr" in error, false);
    return true;
  });
}

for (const exit of [0, 1]) {
  for (const field of ["error", "response"]) {
    test(`usage classifies eligibility from ${field} at exit ${exit}`, async () => {
      await rejectsSafely(fetchCode(output({
        status: "ERROR", [field]: `${eligibility} ${privateDetail}`,
      }, exit)), /account\/location eligibility check/);
    });
  }
  test(`usage distinguishes sign-in at exit ${exit}`, async () => {
    await rejectsSafely(fetchCode(output({
      status: "ERROR", error: `Authentication required. ${privateDetail}`,
    }, exit)), /requires sign-in/);
  });
}

for (const message of [
  "Your location is not supported.",
  "Antigravity is not available in your location.",
  "Your account is not eligible.",
]) {
  test(`usage recognizes eligibility wording: ${message}`, async () => {
    await rejectsSafely(fetchCode(output({ status: "ERROR", error: message })), /eligibility check/);
  });
}

for (const message of ["Not signed in.", "Not logged in.", "Please log in.", "Please sign in.", "Login required."]) {
  test(`usage recognizes sign-in wording: ${message}`, async () => {
    await rejectsSafely(fetchCode(output({ status: "ERROR", error: message })), /requires sign-in/);
  });
}

for (const exit of [0, 1]) {
  for (const field of ["error", "response"]) {
    for (const [message, expected] of [
      [eligibility, /eligibility check/],
      ["Authentication required.", /requires sign-in/],
    ] as const) {
      test(`usage classifies ${message} in ${field} with the other field null at exit ${exit}`, async () => {
        await rejectsSafely(fetchCode(output({
          status: "ERROR", error: null, response: null, command: null,
          [field]: `${message} ${privateDetail}`,
        }, exit)), expected);
      });
    }
  }
}

test("an error envelope need not have a successful usage command payload", async () => {
  await rejectsSafely(fetchCode(output({
    status: "ERROR", error: eligibility, command: null,
  })), /eligibility check/);
});

test("eligibility takes precedence over sign-in advice in the same error", async () => {
  await rejectsSafely(fetchCode(output({
    status: "ERROR", error: eligibility, response: "Please sign in again.",
  })), /eligibility check/);
});

for (const data of [
  { status: "ERROR", error: privateDetail },
  { status: "UNKNOWN", error: eligibility },
  { error: eligibility },
  { status: "ERROR", error: { message: eligibility } },
  { status: "SUCCESS", error: eligibility },
]) {
  test("unknown or malformed nonzero output stays generic and private", async () => {
    await rejectsSafely(fetchCode(output(data, 2)), /command failed \(exit 2\)/);
  });
}

test("stderr and non-JSON stdout are not used for classification", async () => {
  await rejectsSafely(fetchCode(
    `console.error(${JSON.stringify(eligibility + privateDetail)});console.log(${JSON.stringify(privateDetail)});process.exitCode=3`,
  ), /command failed \(exit 3\)/);
});

test("unknown zero-exit errors stay generic and private", async () => {
  await rejectsSafely(fetchCode(output({ status: "ERROR", error: privateDetail }, 0)), /query was not successful/);
});

test("invalid zero-exit data is rejected without echoing output", async () => {
  await rejectsSafely(fetchCode(`console.log(${JSON.stringify(privateDetail)})`), /invalid data/);
});

test("success-looking output never overrides a nonzero exit", async () => {
  await rejectsSafely(fetchCode(output({ status: "SUCCESS", command: {
    name: "usage", data: { groups: [] },
  } }, 7)), /command failed \(exit 7\)/);
});

test("a successful quota payload is not classified from incidental text", async () => {
  const result = await fetchCode(output({ status: "SUCCESS", error: eligibility, command: {
    name: "usage", data: { groups: [{ name: "Gemini models", buckets: [{
      id: "weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.75,
    }] }] },
  } }, 0));
  assert.equal(result.status, "available");
  if (result.status === "available") assert.equal(result.windows[0]?.remainingPct, 75);
});

test("missing executable and execute permission have distinct diagnostics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agy-usage-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await rejectsSafely(fetchCode("", join(directory, "missing")), /executable was not found/);
  const denied = join(directory, "noexec");
  await writeFile(denied, "#!/bin/sh\nexit 0\n");
  await chmod(denied, 0o600);
  await rejectsSafely(fetchCode("", denied), /execute permission/);
});

for (const stream of ["stdout", "stderr"]) {
  test(`${stream} overflow is not mislabeled as timeout or sign-in`, async () => {
    await rejectsSafely(fetchCode(
      `process.${stream}.write('PRIVATE_SENTINEL'.repeat(150000))`,
    ), /output exceeded the size limit/);
  });
}

test("signal termination does not imply sign-out", async () => {
  await rejectsSafely(fetchCode("process.kill(process.pid, 'SIGTERM')"), /interrupted by a signal/);
});

test("real timeout takes precedence over previously emitted diagnostic JSON", async () => {
  const started = Date.now();
  await rejectsSafely(fetchCode(
    `console.log(${JSON.stringify(JSON.stringify({ status: "ERROR", error: eligibility + privateDetail }))});setInterval(() => {}, 1000)`,
  ), /18-second timeout/);
  assert.ok(Date.now() - started >= 17500);
  assert.ok(Date.now() - started < 25000);
});
