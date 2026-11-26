import type { PluginServerContext } from "@getpaseo/plugin/server";
import { provider } from "./server/provider";
export default function contribute(server: PluginServerContext) {
  server.registerProvider(provider());
  return () => {};
}
