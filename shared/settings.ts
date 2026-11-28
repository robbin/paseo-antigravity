import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const STALL_RECOVERY_DEFAULTS = {
  enabled: false,
  stallTimeoutSeconds: 300,
  maxContinuations: 3,
} as const;

export const STALL_TIMEOUT_SECONDS_MIN = 10;
export const STALL_TIMEOUT_SECONDS_MAX = 3600;
export const MAX_CONTINUATIONS_MIN = 0;
export const MAX_CONTINUATIONS_MAX = 10;

export const stallRecoverySettingsSchema = z.object({
  enabled: z.boolean().default(STALL_RECOVERY_DEFAULTS.enabled),
  stallTimeoutSeconds: z
    .number()
    .int()
    .min(STALL_TIMEOUT_SECONDS_MIN)
    .max(STALL_TIMEOUT_SECONDS_MAX)
    .default(STALL_RECOVERY_DEFAULTS.stallTimeoutSeconds),
  maxContinuations: z
    .number()
    .int()
    .min(MAX_CONTINUATIONS_MIN)
    .max(MAX_CONTINUATIONS_MAX)
    .default(STALL_RECOVERY_DEFAULTS.maxContinuations),
});

export type StallRecoverySettings = z.output<typeof stallRecoverySettingsSchema>;

export const stallRecoverySettings = defineSettings({
  id: "stall-recovery",
  scope: "host",
  version: 1,
  schema: stallRecoverySettingsSchema,
});

export type ParseIntResult =
  | { ok: true; value: number }
  | { ok: false; reason: "required" | "integer" | "range" };

export function parseStrictInt(raw: string, min: number, max: number): ParseIntResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "required" };
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "integer" };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, value };
}

export function parseStallTimeoutSeconds(raw: string): ParseIntResult {
  return parseStrictInt(raw, STALL_TIMEOUT_SECONDS_MIN, STALL_TIMEOUT_SECONDS_MAX);
}

export function parseMaxContinuations(raw: string): ParseIntResult {
  return parseStrictInt(raw, MAX_CONTINUATIONS_MIN, MAX_CONTINUATIONS_MAX);
}
