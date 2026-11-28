import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import {
  STALL_RECOVERY_DEFAULTS,
  type StallRecoverySettings,
  type stallRecoverySettingsSchema,
} from "../shared/settings";

export type StallRecoverySettingsHandle = PluginSettings<typeof stallRecoverySettingsSchema>;
export type StallRecoverySettingsState = PluginSettingsState<typeof stallRecoverySettingsSchema>;

export interface RecoverySettingsStore {
  get(): StallRecoverySettings;
  ready(): Promise<StallRecoverySettings>;
  onChange(listener: (values: StallRecoverySettings) => void): () => void;
  dispose(): void;
}

function sameSettings(a: StallRecoverySettings, b: StallRecoverySettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.stallTimeoutSeconds === b.stallTimeoutSeconds &&
    a.maxContinuations === b.maxContinuations
  );
}

export function createRecoverySettingsStore(
  handle: StallRecoverySettingsHandle,
): RecoverySettingsStore {
  let current: StallRecoverySettings = { ...STALL_RECOVERY_DEFAULTS };
  let disposed = false;
  let receivedUpdate = false;
  const listeners = new Set<(values: StallRecoverySettings) => void>();

  const notify = (next: StallRecoverySettings) => {
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Isolate subscriber errors so one connection cannot break others.
      }
    }
  };

  const apply = (next: StallRecoverySettings) => {
    const copy: StallRecoverySettings = {
      enabled: next.enabled,
      stallTimeoutSeconds: next.stallTimeoutSeconds,
      maxContinuations: next.maxContinuations,
    };
    if (sameSettings(current, copy)) return;
    current = copy;
    notify(current);
  };

  const unsubscribe = handle.subscribe((state) => {
    if (disposed || state.status !== "ready") return;
    receivedUpdate = true;
    apply(state.values);
  });

  const initialRead = Promise.resolve()
    .then(() => handle.read())
    .then((state) => {
      if (!disposed && !receivedUpdate && state.status === "ready") {
        apply(state.values);
      }
      return current;
    })
    .catch(() => current);

  return {
    get() {
      return current;
    },
    ready() {
      return initialRead;
    },
    onChange(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      try {
        void unsubscribe();
      } catch {
        // Ignore cleanup failures during plugin teardown.
      }
    },
  };
}
