import test from "node:test";
import assert from "node:assert/strict";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import contribute from "../index.server.ts";

test("contribute registers only the ACP provider, never a usage source", async () => {
  const registrations: ProviderRegistration[] = [];
  const server = new Proxy({
    registerProvider(registration: ProviderRegistration) {
      registrations.push(registration);
    },
  }, {
    get(target, key) {
      // Reject registerUsageSource and every other contribution API, even on cleanup.
      assert.equal(key, "registerProvider", "unexpected plugin contribution");
      return Reflect.get(target, key);
    },
  }) as unknown as PluginServerContext;

  const cleanup = contribute(server);
  assert.equal(registrations.length, 1);
  const registration = registrations[0]!;
  assert.equal(registration.id, "better-paseo-antigravity");
  assert.equal(registration.label, "Better Paseo Antigravity");
  assert.deepEqual(registration.command, ["agy", "acp", "--disable-telemetry"]);
  assert.equal(typeof registration.connect, "function");
  assert.equal(typeof registration.status, "function");
  assert.equal(typeof cleanup, "function");
  await cleanup();
  assert.equal(registrations.length, 1);
});
