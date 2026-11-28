import type { PluginClientContext } from "@getpaseo/plugin/client";
import { messages } from "./client/messages";
import { StallRecoverySettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "stall-recovery",
    title: messages.message("screenTitle"),
    icon: "RefreshCw",
    Component: StallRecoverySettingsScreen,
  });

  return () => {
    removeSettings();
  };
}
