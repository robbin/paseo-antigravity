import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";

const input = z.object({ launch: z.string() }).strict();
const response = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.literal("usage"),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

function parseResponse(stdout: unknown): z.infer<typeof response> | undefined {
  if (typeof stdout !== "string") return undefined;
  try {
    const parsed = response.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// CLI failures can contain account identifiers and authorization URLs. Only
// allowlisted classifications, never raw output or error.cause, reach the UI.
function usageDiagnostic(data: z.infer<typeof response>): string | undefined {
  const detail = `${data.error ?? ""}\n${data.response ?? ""}`;
  if (/not (?:currently )?available in your location|not eligible|location is not supported/i.test(detail))
    return "Headless agy /usage was rejected by its account/location eligibility check. Interactive /usage can behave differently; see docs/usage-eligibility.md.";
  if (/authentication required|not (?:logged|signed) in|please (?:log|sign) in|login required/i.test(detail))
    return "Antigravity usage requires sign-in. Run agy in a terminal on this host and complete sign-in.";
  return undefined;
}

function commandFailure(error: unknown): Error {
  const failure = error !== null && typeof error === "object"
    ? error as { code?: unknown; killed?: unknown; stdout?: unknown }
    : {};
  if (failure.code === "ENOENT")
    return new Error("Antigravity usage executable was not found. Check the daemon PATH or the configured command.");
  if (failure.code === "EACCES")
    return new Error("Antigravity usage executable could not be started. Check its execute permission.");
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new Error("Antigravity usage output exceeded the size limit.");
  if (failure.killed === true)
    return new Error("Antigravity usage exceeded the 18-second timeout or was interrupted.");
  const data = parseResponse(failure.stdout);
  const diagnostic = data && data.status !== "SUCCESS" ? usageDiagnostic(data) : undefined;
  return new Error(diagnostic ?? (typeof failure.code === "number" && Number.isInteger(failure.code)
    ? `Antigravity usage command failed (exit ${failure.code}). Check the CLI logs on this host.`
    : "Antigravity usage command failed. Check the CLI logs on this host."));
}

// These ACP-only options have no verified equivalent for the top-level /usage
// command. Never silently query the default account when they are present.
function directoryArgs(args: readonly string[]): string[] {
  return args.flatMap((arg, index) =>
    /^(--app[-_]data[-_]dir|--gemini[-_]dir|--cli_dir_name)(=|$)/.test(arg)
      ? [arg, ...(arg.includes("=") ? [] : [args[index + 1] ?? ""])]
      : []);
}

function resetTime(value: string | null | undefined): string | null {
  const timestamp = value == null ? NaN : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? value! : null;
}

function accountKey(env: ProviderLaunch["env"]): string {
  return hashAccountKey(
    path.resolve(
      env.ANTIGRAVITY_HOME ??
        path.join(env.HOME ?? homedir(), ".gemini", "antigravity-cli"),
    ),
  );
}

function formatWindowLabel(name: string, window: string): string {
  if (window.trim().toLowerCase() === "5h") return "5h";
  return name.trim().replace(/(?:\s+Limit)?\s+Remaining$/i, "");
}

function shortWindow(window: string): string {
  const trimmed = window.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "monthly") return "mo";
  return trimmed;
}

function windowDurationSeconds(window: string): number | undefined {
  switch (window.trim().toLowerCase()) {
    case "5h":
      return 5 * 3600;
    case "weekly":
      return 7 * 86400;
    default:
      return undefined;
  }
}

function formatGroupLabel(name: string): string {
  return name
    .trim()
    .replace(/(?:^|\s+)models$/i, "")
    .trim();
}

function formatShortLabel(groupLabel: string, window: string): string {
  const period = shortWindow(window);
  return groupLabel ? `${groupLabel} ${period}` : period;
}

export class Usage {
  private readonly launches = new Map<string, ProviderLaunch>();

  registration(): UsageSourceRegistration {
    return {
      id: "better-paseo-antigravity",
      label: "Better Paseo Antigravity",
      icon: "icon.svg",
      input,
      provider: "better-paseo-antigravity",
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== "better-paseo-antigravity")
          return [];
        if (!scope.launch) return [];
        const launch = { ...scope.launch, env: {
          ...scope.launch.env, ...(scope.kind === "session" ? scope.env : {}),
        } };
        const directories = directoryArgs(launch.args);
        const key = directories.length
          ? hashAccountKey(JSON.stringify([accountKey(launch.env), directories]))
          : accountKey(launch.env);
        const locator = hashAccountKey(JSON.stringify(launch));
        this.launches.set(locator, launch);
        return [{ key, input: { launch: locator } }];
      },
      fetch: async (value) => {
        const { launch: locator } = input.parse(value);
        const launch = this.launches.get(locator);
        if (!launch) throw new Error("Antigravity launch no longer exists");
        const acpIndex = launch.args.indexOf("acp");
        if (acpIndex < 0)
          throw new Error(
            "Antigravity launch does not contain the acp subcommand",
          );
        if (directoryArgs(launch.args).length)
          throw new Error("Usage queries with custom ACP data directories are not supported; no default account was queried.");
        let result;
        try {
          result = await execCommand(
            launch.command,
            [
              ...launch.args.slice(0, acpIndex),
              "-p",
              "/usage",
              "--output-format",
              "json",
            ],
            {
              env: launch.env,
              timeout: 18_000,
              maxBuffer: 1024 * 1024,
            },
          );
        } catch (error) {
          throw commandFailure(error);
        }
        const data = parseResponse(result.stdout);
        if (!data)
          throw new Error("Antigravity usage returned invalid data.");
        if (data.status !== "SUCCESS")
          throw new Error(usageDiagnostic(data) ?? "Antigravity usage query was not successful.");
        if (!data.command) throw new Error("agy did not return usage data");
        const groups = data.command.data.groups;
        const includeGroup = groups.length > 1;
        const windows = groups.flatMap((group) => {
          const groupLabel = formatGroupLabel(group.name);
          return group.buckets.flatMap((bucket) => {
            if (!bucket.disabled && bucket.remaining_fraction == null)
              return [];
            const used = bucket.disabled
              ? null
              : (1 - bucket.remaining_fraction!) * 100;
            return [
              windowFromUsedPct({
                id: bucket.id,
                label: [
                  groupLabel,
                  formatWindowLabel(bucket.name, bucket.window),
                  bucket.disabled ? "Disabled" : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                shortLabel: formatShortLabel(
                  includeGroup ? groupLabel : "",
                  bucket.window,
                ),
                summary: !bucket.disabled && bucket.window === "weekly",
                utilizationPct: used,
                durationSeconds: windowDurationSeconds(bucket.window),
                resetsAt: bucket.disabled ? null : resetTime(bucket.reset_time),
                tone: used === null ? "default" : toneFromUsedPct(used),
              }),
            ];
          });
        });
        if (windows.length === 0)
          return unavailable({
            kind: "no_quota",
            detail: "No usage quota reported by agy",
          });
        return { status: "available", windows };
      },
    };
  }
}
