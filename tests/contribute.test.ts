import test from "node:test";
import assert from "node:assert/strict";
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { SettingsDefinition } from "@getpaseo/plugin";
import contribute from "../index.server.ts";
import { STALL_RECOVERY_DEFAULTS, stallRecoverySettings } from "../shared/settings.ts";

test("contribute registers only settings and the ACP provider, never a usage source", async () => {
  const registrations: ProviderRegistration[] = [];
  const registeredSettings: SettingsDefinition[] = [];
  let unsubscribed = 0;

  const server = new Proxy({
    registerSettings(definition: SettingsDefinition) {
      registeredSettings.push(definition);
      return {
        read: async () => ({
          status: "ready" as const,
          revision: "rev-1",
          values: { ...STALL_RECOVERY_DEFAULTS },
        }),
        subscribe: () => () => {
          unsubscribed++;
        },
      } as unknown as PluginSettings<typeof stallRecoverySettings.schema>;
    },
    registerProvider(registration: ProviderRegistration) {
      registrations.push(registration);
    },
  }, {
    get(target, key) {
      // Reject registerUsageSource and every other contribution API, even on cleanup.
      assert.ok(
        key === "registerProvider" || key === "registerSettings",
        `unexpected plugin contribution: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as unknown as PluginServerContext;

  const cleanup = contribute(server);
  assert.equal(registeredSettings.length, 1);
  assert.equal(registeredSettings[0]?.id, "stall-recovery");
  assert.equal(registeredSettings[0]?.scope, "host");
  assert.equal(registeredSettings[0]?.version, 1);

  assert.equal(registrations.length, 1);
  const registration = registrations[0]!;
  assert.equal(registration.id, "better-paseo-antigravity");
  assert.equal(registration.label, "Better Paseo Antigravity");
  assert.deepEqual(registration.command, ["agy", "acp", "--disable-telemetry"]);
  assert.equal(typeof registration.connect, "function");
  assert.equal(typeof registration.status, "function");
  assert.equal(typeof cleanup, "function");

  assert.equal(unsubscribed, 0);
  await cleanup();
  assert.equal(unsubscribed, 1);
  assert.equal(registrations.length, 1);
});
