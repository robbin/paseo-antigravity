import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export function cliVersion(stdout: string): string | undefined {
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+)(?=$|[^\d.])/.exec(stdout)?.[1];
}

export const MINIMUM_VERSION_ERROR = "需要官方 agy 1.5.15 或更新版本。";
export async function checkCliVersion(launch: ProviderLaunch, timeout = 10000): Promise<string> {
  const prefix = launch.args.indexOf("acp");
  if (prefix < 0) throw new Error("启动参数必须包含 acp。");
  let stdout: string;
  try {
    ({ stdout } = await execCommand(launch.command,
      [...launch.args.slice(0, prefix), "--version"],
      {env: launch.env, timeout, maxBuffer:8192}));
  } catch {
    throw new Error("CLI 版本检查失败或超过启动时限。请检查可执行文件与登录环境。");
  }
  const version = cliVersion(stdout);
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (!version || major < 1 ||
    (major === 1 && (minor < 5 || (minor === 5 && patch < 15))))
    throw new Error(MINIMUM_VERSION_ERROR);
  return version;
}
