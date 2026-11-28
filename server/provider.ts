import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderRegistration,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import {
  createTransport,
  type Context,
  type OwnedTransport,
} from "./transport";
import { vendor, options } from "./vendor";
import { defaults, turnMetadata, type Limits } from "./watch";
import { normalizeSessionCwds } from "./session-cwd";
import { checkCliVersion, cliVersion } from "./cli-version";
import { Recovery, type RecoveryConfig, type RecoveryOptions } from "./recovery";
import { STALL_RECOVERY_DEFAULTS } from "../shared/settings";
import {
  createRecoverySettingsStore,
  type RecoverySettingsStore,
  type StallRecoverySettingsHandle,
} from "./settings-store";

// Capture diagnostics per request object so reused IDs cannot inherit old failures.
interface RequestState { failure?: string; sessionId?: string }

export function provider(
  testOptions: {
    limits?: Limits;
    recovery?: RecoveryOptions;
    settings?: StallRecoverySettingsHandle;
    settingsStore?: RecoverySettingsStore;
    // Test-only time scale override for converting stallTimeoutSeconds to ms.
    stallMsFromSeconds?: (seconds: number) => number;
    closeTimeoutMs?: number;
    statusTimeoutMs?: number;
    // Explicit dependency injection for mock executables, never a daemon setting.
    checkVersion?: typeof checkCliVersion;
  } = {},
): ProviderRegistration {
  return {
    id: "better-paseo-antigravity",
    label: "Better Paseo Antigravity",
    icon: "icon.svg",
    description: "Reuses official CLI sign-in and configuration; optional SSE stall auto-recovery (off by default, configurable in plugin settings).",
    command: ["agy", "acp", "--disable-telemetry"],
    docsUrl: "https://paseo.sh/docs/supported-providers/antigravity",
    installation: {
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const prefix = launch.args.indexOf("acp");
        try {
          const { stdout } = await execCommand(
            launch.command,
            [...(prefix < 0 ? launch.args : launch.args.slice(0, prefix)), "--version"],
            { env: launch.env, signal, timeout: 10000, maxBuffer: 8192 },
          );
          return { status: "installed", version: cliVersion(stdout) };
        } catch {
          // Preserve cancellation without exposing the caller's reason or exec output.
          if (signal.aborted) {
            const error = new Error("CLI installation inspection cancelled.");
            error.name = "AbortError";
            throw error;
          }
          throw new Error("CLI installation inspection failed or timed out.");
        }
      },
    },
    async status({ launch }) {
      if (!launch)
        return { available: false, diagnostic: "Official agy CLI not found." };
      const ssh = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].find(
        (key) => launch.env[key],
      );
      const signIn = ssh
        ? `SSH environment (${ssh}): CLI sign-in source may differ from a local terminal.`
        : "Non-SSH environment: uses the CLI's existing sign-in source.";
      const deadline =
        Date.now() +
        (testOptions.statusTimeoutMs ?? options.startupTimeoutMs ?? 95000);
      const remaining = () => Math.max(1, deadline - Date.now());
      let phase = "CLI version check";
      let safeFailure: string | undefined;
      try {
        const version = await (testOptions.checkVersion ?? checkCliVersion)(launch, remaining());
        phase = "ACP handshake";
        const probes = new Set<OwnedTransport>();
        try {
          const probe = runAcpProvider({
            id: "better-paseo-antigravity",
            label: "Better Paseo Antigravity",
            acpOptions: { startupTimeoutMs: remaining() },
            connector: () => {
              const t = createTransport(
                launch,
                { cwd: homedir(), env: {} },
                () => {},
                {
                  ...defaults,
                  startup: Math.min(defaults.startup, remaining()),
                },
                (message) => {
                  safeFailure ??= message;
                },
                () => {},
                () => ({ enabled: false, stallMs: defaults.stall! }),
              );
              probes.add(t);
              return t.stream;
            },
          });
          const connection = await probe.connect({
            launch,
            versions: [1],
            capabilities: [],
          });
          await connection.close();
        } finally {
          await Promise.allSettled([...probes].map((t) => t.close()));
        }
        return {
          available: true,
          diagnostic: `CLI ${version} and ACP handshake succeeded. Account and model access are still verified when opening a session.\n${signIn}`,
        };
      } catch (error) {
        if (phase === "CLI version check" && error instanceof Error)
          safeFailure = error.message;
        return {
          available: false,
          // Only our fixed transport diagnostics are safe to show. Never echo raw
          // exec/SDK errors, which can contain command output or an authorization URL.
          diagnostic: `${safeFailure ?? `${phase} failed or exceeded the startup timeout. Check the executable, acp arguments, and sign-in environment.`}\n${signIn}`,
        };
      }
    },
    async connect(request): Promise<ProviderConnection> {
      if (!request.launch) throw new Error("Missing official CLI launch configuration.");
      const launch = request.launch;
      await (testOptions.checkVersion ?? checkCliVersion)(launch);
      const scope = new AsyncLocalStorage<Context & { request?: RequestState }>();
      const owned = new Set<OwnedTransport>();
      const listeners = new Set<(e: ProviderEvent) => void>();
      const transports = new Map<string, OwnedTransport>();
      const failures = new Map<string, string>();
      // All host request IDs share the SDK acknowledgement namespace, not only
      // Stop IDs. Reserve before dispatch to reject collisions in either order.
      const requests = new Map<string, RequestState>();
      const stops = new Map<string, { transport: OwnedTransport; token: number }>();
      const settleStop = (id: string, rejected = false) => {
        const stop = stops.get(id);
        if (!stop) return;
        stops.delete(id);
        stop.transport.watch.settleStop(stop.token, rejected);
      };
      // send() acknowledges admission, not execution. prompt_result settles
      // each queued request, including failures reported asynchronously.
      const replacements = new Map<string, Set<string>>();
      const forgetReplacement = (sessionId: string, messageId: string) => {
        const pending = replacements.get(sessionId);
        pending?.delete(messageId);
        if (!pending?.size) replacements.delete(sessionId);
      };
      let closed = false;
      let connectionClosing: Promise<void> | undefined;
      const emit = (e: ProviderEvent) => {
        if (!closed) for (const l of listeners) l(e);
      };
      const store = testOptions.settingsStore ??
        (testOptions.settings ? createRecoverySettingsStore(testOptions.settings) : undefined);
      const ownsStore = !testOptions.settingsStore && store !== undefined;
      if (store) await store.ready();
      const stallMsFromSeconds = testOptions.stallMsFromSeconds ?? ((seconds: number) => seconds * 1000);
      const getRecoveryConfig = (): RecoveryConfig => {
        if (testOptions.recovery?.getConfig) return testOptions.recovery.getConfig();
        if (store) {
          const s = store.get();
          return {
            enabled: s.enabled,
            stallMs: stallMsFromSeconds(s.stallTimeoutSeconds),
            maxContinuations: s.maxContinuations,
          };
        }
        return {
          enabled: testOptions.recovery?.enabled ?? STALL_RECOVERY_DEFAULTS.enabled,
          stallMs: testOptions.limits?.stall ?? defaults.stall!,
          maxContinuations: testOptions.recovery?.maxContinuations ?? STALL_RECOVERY_DEFAULTS.maxContinuations,
        };
      };
      const recovery = new Recovery({
        transport: sessionId => transports.get(sessionId),
        // Do not enqueue an automatic prompt behind configure/open/close work in
        // the SDK mutation lane: an admitted queued prompt cannot be retracted.
        pending: sessionId => (replacements.get(sessionId)?.size ?? 0) > 0 ||
          [...requests.values()].some(r => r.sessionId === sessionId),
        send: input => connection.send(input, true),
        emit,
      }, testOptions.limits?.stall ?? defaults.stall!, {
        ...testOptions.recovery,
        getConfig: getRecoveryConfig,
      });
      const offSettings = store?.onChange(() => {
        const now = Date.now();
        for (const t of transports.values()) t.watch.syncRecovery(now);
        recovery.onConfigChange();
      });
      const cleanupSettings = () => {
        offSettings?.();
        if (ownsStore) store?.dispose();
      };
      const shim = runAcpProvider({
        id: "better-paseo-antigravity",
        label: "Better Paseo Antigravity",
        acpOptions: options,
        transformers: [vendor],
        connector: () => {
          if (closed) throw new Error("Provider is closed.");
          const context = scope.getStore() ?? { cwd: homedir(), env: {} };
          if (context.sessionId) failures.delete(context.sessionId);
          const transport = createTransport(
            launch,
            context,
            (message) => {
              if (context.sessionId) {
                emit({
                  type: "session.notice",
                  sessionId: context.sessionId,
                  notice: {
                    id: "antigravity-progress",
                    severity: "warning",
                    title: message,
                  },
                });
              }
            },
            testOptions.limits,
            (message) => {
              if (context.request) context.request.failure ??= message;
              if (context.sessionId && !failures.has(context.sessionId))
                failures.set(context.sessionId, message);
            },
            turnId => {
              if (context.sessionId && transports.get(context.sessionId) === transport)
                recovery.stall(context.sessionId, turnId);
            },
            () => {
              const cfg = getRecoveryConfig();
              return { enabled: cfg.enabled, stallMs: cfg.stallMs };
            },
          );
          if (context.sessionId) transports.set(context.sessionId, transport);
          owned.add(transport);
          void transport.finished.then(() => {
            owned.delete(transport);
            for (const [id, stop] of stops)
              if (stop.transport === transport) settleStop(id);
            // SDK terminal events may arrive after process cleanup. Keep its Watch
            // until session.closed/reopen so the terminal turn diagnostic survives.
          });
          return transport.stream;
        },
      });
      let core: ProviderConnection;
      try {
        core = await shim.connect(request);
      } catch (e) {
        cleanupSettings();
        await Promise.allSettled([...owned].map((t) => t.close()));
        throw e;
      }
      const off = core.onEvent((e) => {
        const wireStopReason = "sessionId" in e
          ? transports.get(e.sessionId)?.watch.turn?.stopReason : undefined;
        const requestFailure = e.type === "request.failed"
          ? requests.get(e.requestId)?.failure : undefined;
        if ((e.type === "request.completed" || e.type === "request.failed" ||
            e.type === "catalog" || e.type === "sessions" || e.type === "session.ready") &&
            typeof e.requestId === "string") {
          requests.delete(e.requestId);
          settleStop(e.requestId);
        }
        if (e.type === "session.prompt_result")
          forgetReplacement(e.sessionId, e.clientMessageId);
        if (e.type === "session.closed" || e.type === "session.runtime_failed")
          replacements.delete(e.sessionId);
        // Paseo validates the import directory before sending session.open.
        if (e.type === "sessions")
          e = {
            ...e,
            sessions: normalizeSessionCwds(e.sessions),
          };
        if (
          e.type === "request.failed" ||
          e.type === "session.runtime_failed" ||
          (e.type === "session.turn" && e.state === "failed")
        ) {
          const reason = e.type === "request.failed" ? requestFailure : failures.get(e.sessionId);
          if (
            reason &&
            [
              "ACP transport closed unexpectedly",
              "Connection closed",
              "ACP connection closed",
              "ACP turn failed",
            ].includes(e.error?.message ?? "")
          )
            e = { ...e, error: { ...e.error, message: reason } };
        }
        if (e.type === "session.closed") {
          transports.delete(e.sessionId);
          failures.delete(e.sessionId);
        }
        if (e.type === "session.turn") {
          const watch = transports.get(e.sessionId)?.watch;
          if (e.state === "started") watch?.startTurn(e.turnId);
          else if (watch?.turn?.turnId === e.turnId) {
            const t = watch.turn;
            // A successor can retire a deferred turn without wire cancel. Read
            // the queue at settlement, not when callers enqueue against an old turn.
            t.replaced ||= (replacements.get(e.sessionId)?.size ?? 0) > 0;
            const metadata = turnMetadata(t);
            console.log("[antigravity:turn-end]", JSON.stringify({ sessionId: e.sessionId,
              state: e.state, ...metadata, endedAt: Date.now() }));
            const empty = !t.text && !t.results;
            if (e.state === "completed" && !metadata.canceled && !t.replaced &&
                (empty || ((t.completed + t.failed) > 0 && !t.trailingText)))
              emit({
                type: "session.notice",
                sessionId: e.sessionId,
                notice: {
                  id: empty ? "antigravity-empty" : "antigravity-tool-only",
                  severity: empty ? "warning" : "info",
                  title: empty
                    ? "Turn ended without returning text or tool results. Check the official CLI for errors; the message was not resent."
                    : `Turn ended after foreground tools ${t.failed ? "failed" : "completed"} without returning a follow-up reply; the message was not resent.`,
                },
              });
            watch.endTurn(e.turnId, e.state === "completed");
          }
        }
        if (
          e.type === "timeline.item" &&
          e.item.type === "tool_call" &&
          ["completed", "failed", "canceled"].includes(e.item.status)
        ) {
          transports.get(e.sessionId)?.watch.finishTool(e.item.callId);
        }
        if (!recovery.event(e, wireStopReason)) emit(e);
      });
      const connection = {
        version: core.version,
        capabilities: core.capabilities,
        onEvent(l: (e: ProviderEvent) => void) {
          listeners.add(l);
          return () => {
            listeners.delete(l);
          };
        },
        send(input: ProviderInput, automatic = false) {
          if (closed) return Promise.reject(new Error("Provider is closed."));
          const requestId = "requestId" in input && typeof input.requestId === "string"
            ? input.requestId : undefined;
          if (requestId !== undefined && requests.has(requestId))
            return Promise.reject(new Error("Request ID is already in use."));
          if (!automatic) recovery.userInput(input);
          const reservation: RequestState = {
            sessionId: "sessionId" in input ? input.sessionId : undefined,
          };
          // Capture identity before dispatch. Admission is async but immediate;
          // its rejection rolls back only this provisional Stop token. Request
          // completion may arrive before send().then(), so never arm in then().
          let stopId: string | undefined;
          let stopEntry: {transport: OwnedTransport; token: number} | undefined;
          if (input.type === "session.interrupt" && typeof input.requestId === "string" &&
              input.requestId.length > 0 && !stops.has(input.requestId)) {
            const transport = transports.get(input.sessionId);
            const token = transport?.watch.requestStop();
            if (transport && token !== undefined) {
              stopId = input.requestId;
              stopEntry = {transport, token};
              stops.set(stopId, stopEntry);
            }
          }
          const rollbackStop = () => {
            if (requestId !== undefined && requests.get(requestId) === reservation)
              requests.delete(requestId);
            if (stopId !== undefined && stops.get(stopId) === stopEntry) settleStop(stopId, true);
          };
          const replacement = input.type === "session.prompt" && input.prompt.delivery !== "steer"
            ? { sessionId: input.sessionId, id: input.prompt.clientMessageId } : undefined;
          if (replacement) {
            let pending = replacements.get(replacement.sessionId);
            if (!pending) replacements.set(replacement.sessionId, pending = new Set());
            pending.add(replacement.id);
          }
          const context: Context =
            input.type === "session.open"
              ? {
                  cwd: input.config.cwd,
                  env: input.config.env,
                  sessionId: input.sessionId,
                }
              : {
                  // sessions.cwd is an ACP query filter, not a launch directory.
                  cwd: input.type === "catalog" && input.cwd ? input.cwd : homedir(),
                  env: {},
                };
          if (requestId !== undefined) requests.set(requestId, reservation);
          try {
            return scope.run({ ...context, request: reservation }, () => core.send(input)).catch(error => {
              if (replacement) forgetReplacement(replacement.sessionId, replacement.id);
              rollbackStop();
              throw error;
            });
          } catch (error) {
            if (replacement) forgetReplacement(replacement.sessionId, replacement.id);
            rollbackStop();
            return Promise.reject(error);
          }
        },
        close() {
          return (connectionClosing ??= (async () => {
            closed = true;
            cleanupSettings();
            recovery.close();
            off();
            listeners.clear();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const graceful = core.close();
            try {
              await Promise.race([
                graceful,
                new Promise<void>((resolve) => {
                  timer = setTimeout(
                    resolve,
                    testOptions.closeTimeoutMs ?? 5000,
                  );
                  timer.unref();
                }),
              ]);
            } catch {
              /* force cleanup also runs when graceful close fails */
            } finally {
              clearTimeout(timer);
              await Promise.allSettled([...owned].map((t) => t.close()));
              owned.clear();
              transports.clear();
              failures.clear();
              replacements.clear();
              stops.clear();
              requests.clear();
            }
            // Do not wait indefinitely for an SDK operation stuck outside the transport.
            void graceful.catch(() => {});
          })());
        },
      };
      return connection;
    },
  };
}
