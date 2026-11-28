import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"),
);

test("Paseo compatibility keeps the minimum without an upper bound", () => {
  // Do not exclude newer daemons (such as 0.18.0) without a known API break.
  // Keep 0.17.3 itself supported, not just versions strictly above it.
  assert.equal(manifest.requirements.paseo, ">=0.17.3");
});

test("manifest icon and listing media assets exist inside the plugin directory", () => {
  assert.equal(manifest.icon, "icon.png");
  assert.ok(existsSync(new URL(`../${manifest.icon}`, import.meta.url)));
  assert.deepEqual(manifest.media, [
    "assets/settings-screen.png",
    "assets/sse-stall-recovery.png",
  ]);
  for (const asset of manifest.media as string[]) {
    assert.ok(!asset.startsWith("/") && !asset.includes(".."), `unsafe asset path: ${asset}`);
    assert.ok(existsSync(new URL(`../${asset}`, import.meta.url)), `missing media asset: ${asset}`);
  }
});
