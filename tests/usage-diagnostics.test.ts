import test from "node:test";
import assert from "node:assert/strict";
import { Usage } from "../server/usage.ts";

async function fetchCode(code: string, command = process.execPath) {
  const source = new Usage().registration();
  const [account] = await source.discover({ kind: "global", launch: {
    command, args: ["-e", code, "--", "acp"], env: {},
  } });
  return source.fetch(account!.input);
}

const privateDetail = "PRIVATE_SENTINEL private@example.com https://accounts.google.com/?code=PRIVATE_SENTINEL";
const failure = (error: string, exit = 1) =>
  `console.log(${JSON.stringify(JSON.stringify({ status: "ERROR", error }))});process.exit(${exit})`;

for (const exit of [0, 1]) {
  test(`usage preserves a safe eligibility classification with exit ${exit}`, async () => {
    await assert.rejects(fetchCode(failure(
      `Eligibility check failed: not currently available in your location. ${privateDetail}`, exit,
    )), (error: Error) => {
      assert.match(error.message, /eligibility check/);
      assert.match(error.message, /Interactive \/usage/);
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|private@|accounts\.google|signed in|timeout/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test("usage distinguishes missing executable and genuine sign-in requirement", async () => {
  await assert.rejects(fetchCode("", "/definitely-not-installed/agy"), /executable was not found/);
  await assert.rejects(fetchCode(failure(`Authentication required. ${privateDetail}`)), (error: Error) => {
    assert.match(error.message, /requires sign-in/);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|private@|accounts\.google/);
    return true;
  });
});

test("unknown nonzero errors only expose the numeric exit code", async () => {
  await assert.rejects(fetchCode(failure(privateDetail, 2)), (error: Error) => {
    assert.match(error.message, /exit 2/);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|private@|accounts\.google|sign-in/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("an invalid successful response never echoes CLI output", async () => {
  await assert.rejects(fetchCode(`console.log(${JSON.stringify(privateDetail)})`), (error: Error) => {
    assert.match(error.message, /invalid data/);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|private@|accounts\.google/);
    return true;
  });
});

test("a real process timeout stays bounded without claiming sign-out", async () => {
  const started = Date.now();
  await assert.rejects(fetchCode("setInterval(() => {}, 1000)"), (error: Error) => {
    assert.match(error.message, /18-second timeout/);
    assert.doesNotMatch(error.message, /sign-in|signed in/);
    return true;
  });
  assert.ok(Date.now() - started < 25000);
});
