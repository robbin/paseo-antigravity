import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export function cliVersion(stdout: string): string | undefined {
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+)(?=$|[^\d.])/.exec(stdout)?.[1];
}

export const MINIMUM_VERSION_ERROR = "Official agy CLI 1.5.15 or newer is required.";
export async function checkCliVersion(launch: ProviderLaunch, timeout = 10000): Promise<string> {
  const prefix = launch.args.indexOf("acp");
  if (prefix < 0) throw new Error("Launch arguments must include acp.");
  let stdout: string;
  try {
    ({ stdout } = await execCommand(launch.command,
      [...launch.args.slice(0, prefix), "--version"],
      {env: launch.env, timeout, maxBuffer:8192}));
  } catch {
    throw new Error("CLI version check failed or exceeded the startup timeout. Check the executable and sign-in environment.");
  }
  const version = cliVersion(stdout);
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (!version || major < 1 ||
    (major === 1 && (minor < 5 || (minor === 5 && patch < 15))))
    throw new Error(MINIMUM_VERSION_ERROR);
  return version;
}
