import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"),
);

test("Paseo compatibility keeps the minimum without an upper bound", () => {
  // Do not exclude newer daemons (such as 0.18.0) without a known API break.
  // Keep 0.17.3 itself supported, not just versions strictly above it.
  assert.equal(manifest.requirements.paseo, ">=0.17.3");
});
