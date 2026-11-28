import type { PluginServerContext } from "@getpaseo/plugin/server";
import { stallRecoverySettings } from "./shared/settings";
import { createRecoverySettingsStore } from "./server/settings-store";
import { provider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(stallRecoverySettings);
  const settingsStore = createRecoverySettingsStore(settings);
  server.registerProvider(provider({ settingsStore }));
  return () => {
    settingsStore.dispose();
  };
}
