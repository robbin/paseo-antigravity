import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import React, { type ReactElement, type ReactNode } from "react";
import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import type { stallRecoverySettingsSchema } from "../shared/settings.ts";

// Shared harness state bridged to mocked client modules registered via Node module hooks.
type MockSettingsState = SettingsState<typeof stallRecoverySettingsSchema>;
interface ClientHarness {
  settingsState: MockSettingsState;
  toasts: Array<{ message: string; variant?: string }>;
  locale: string;
}

const g = globalThis as unknown as { __paseoClientTestHarness?: ClientHarness; React?: typeof React };
// tsx uses root tsconfig.json (classic JSX transform) when loading .tsx in Node tests.
g.React = React;
const CLIENT_ENTRY_PATH = "../index.client.tsx";
const SETTINGS_SCREEN_PATH = "../client/settings-screen.tsx";

type ClientContributeFn = (client: {
  addSettingsScreen(contrib: { id: string; icon: unknown; title: unknown; Component: unknown }): () => void;
}) => () => void | Promise<void>;
type SettingsScreenComponent = (props: PluginSurfaceProps) => ReactElement | null;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "react-native" ||
      specifier === "@getpaseo/plugin/client" ||
      specifier === "@getpaseo/plugin/client/ui"
    ) {
      return {
        shortCircuit: true,
        url: `paseo-test-mock:${specifier}`,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "paseo-test-mock:react-native") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export const View = "View";
          export const Text = "Text";
          export const Pressable = "Pressable";
        `,
      };
    }
    if (url === "paseo-test-mock:@getpaseo/plugin/client/ui") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export const Loading = "Loading";
          export const SettingsSection = "SettingsSection";
          export const SettingsCard = "SettingsCard";
          export const SettingsSwitch = "SettingsSwitch";
          export const SettingsInput = "SettingsInput";
          export const SettingsRow = "SettingsRow";
          export const SettingsAction = "SettingsAction";
          export function useToast() {
            return {
              show(message, options) {
                globalThis.__paseoClientTestHarness?.toasts.push({ message, variant: options?.variant });
              },
              error(message) {
                globalThis.__paseoClientTestHarness?.toasts.push({ message, variant: "error" });
              },
            };
          }
        `,
      };
    }
    if (url === "paseo-test-mock:@getpaseo/plugin/client") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export function defineTranslations(def) {
            return {
              resources: def.resources,
              message(key) { return { __messageKey: key }; },
            };
          }
          export function useTranslation(messages) {
            const locale = globalThis.__paseoClientTestHarness?.locale ?? "en";
            const dict = messages.resources[locale] ?? messages.resources.en;
            return {
              locale,
              t(key, vars) {
                const raw = dict[key] ?? messages.resources.en[key] ?? String(key);
                if (!vars) return raw;
                return raw.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => (k in vars ? String(vars[k]) : "{{" + k + "}}"));
              },
            };
          }
          export function useSettings() {
            return globalThis.__paseoClientTestHarness.settingsState;
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

// Minimal synchronous React functional-component renderer supporting hooks
// (useState, useRef, useMemo, useEffect) for deterministic tree inspection.
interface VNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<VNode | string>;
}

interface ComponentInstance {
  hooks: unknown[];
  pendingEffects: Array<() => void>;
}

function createRenderer() {
  const instances = new Map<string, ComponentInstance>();
  let activeInstance: ComponentInstance | undefined;
  let hookIdx = 0;

  const prevDispatcher = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  let stateDirty = false;
  const dispatcher = {
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const inst = activeInstance!;
      const idx = hookIdx++;
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((prev: T) => T)) => {
        const prev = inst.hooks[idx] as T;
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (!Object.is(prev, resolved)) {
          inst.hooks[idx] = resolved;
          stateDirty = true;
        }
      };
      return [inst.hooks[idx] as T, setState];
    },
    useRef<T>(initial: T) {
      const inst = activeInstance!;
      const idx = hookIdx++;
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = { current: initial };
      }
      return inst.hooks[idx] as { current: T };
    },
    useMemo<T>(factory: () => T, deps?: unknown[]) {
      const inst = activeInstance!;
      const idx = hookIdx++;
      const entry = inst.hooks[idx] as { value: T; deps?: unknown[] } | undefined;
      const changed =
        !entry ||
        !deps ||
        !entry.deps ||
        deps.length !== entry.deps.length ||
        deps.some((d, i) => !Object.is(d, entry.deps![i]));
      if (changed) {
        const value = factory();
        inst.hooks[idx] = { value, deps };
        return value;
      }
      return entry.value;
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const inst = activeInstance!;
      const idx = hookIdx++;
      const entry = inst.hooks[idx] as { deps?: unknown[] } | undefined;
      const changed =
        !entry ||
        !deps ||
        !entry.deps ||
        deps.length !== entry.deps.length ||
        deps.some((d, i) => !Object.is(d, entry.deps![i]));
      if (changed) {
        inst.hooks[idx] = { deps };
        inst.pendingEffects.push(() => {
          effect();
        });
      }
    },
  };

  function expand(node: ReactNode, path: string): Array<VNode | string> {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") return [String(node)];
    if (Array.isArray(node)) {
      return node.flatMap((child, idx) => expand(child, `${path}.${idx}`));
    }
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "symbol") {
      return expand(el.props.children as ReactNode, `${path}.frag`);
    }
    if (typeof el.type === "function") {
      const fn = el.type as (props: Record<string, unknown>) => ReactNode;
      const key = `${path}:${fn.name || "anon"}`;
      let inst = instances.get(key);
      if (!inst) {
        inst = { hooks: [], pendingEffects: [] };
        instances.set(key, inst);
      }
      const prevInst = activeInstance;
      const prevIdx = hookIdx;
      activeInstance = inst;
      hookIdx = 0;
      const rendered = fn(el.props);
      activeInstance = prevInst;
      hookIdx = prevIdx;
      return expand(rendered, key);
    }
      const { children, ...rest } = el.props;
      const vnode: VNode = {
        type: String(el.type),
        props: rest,
        children: expand(children as ReactNode, `${path}.${String(el.type)}`),
      };
      // Attach ref handles for SettingsInput so tests verify replaceText() syncs.
      const refObj = (rest as { ref?: { current: unknown } }).ref;
      if (vnode.type === "SettingsInput" && refObj && !refObj.current) {
        let text = String(rest.initialValue ?? "");
        const replaced: string[] = [];
        refObj.current = {
          focus() {},
          blur() {},
          getText: () => text,
          replaceText(next: string) {
            text = next;
            replaced.push(next);
          },
          __replaced: replaced,
        };
      }
      return [vnode];
  }

  function render(element: ReactElement): VNode[] {
    const saved = prevDispatcher?.H;
    if (prevDispatcher) prevDispatcher.H = dispatcher;
    try {
      let tree: VNode[] = [];
      for (let pass = 0; pass < 10; pass++) {
        stateDirty = false;
        tree = expand(element, "root").filter((n): n is VNode => typeof n !== "string");
        for (const inst of instances.values()) {
          const effects = inst.pendingEffects.splice(0);
          for (const fn of effects) fn();
        }
        if (!stateDirty) break;
      }
      return tree;
    } finally {
      if (prevDispatcher) prevDispatcher.H = saved;
    }
  }

  return { render };
}

function findAll(nodes: Array<VNode | string>, predicate: (n: VNode) => boolean): VNode[] {
  const out: VNode[] = [];
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (predicate(n)) out.push(n);
    out.push(...findAll(n.children, predicate));
  }
  return out;
}

function textContent(nodes: Array<VNode | string>): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : textContent(n.children)))
    .join(" ");
}

const surfaceProps: PluginSurfaceProps = {
  theme: {
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      accent: "#09f",
      accentForeground: "#fff",
      statusSuccess: "#0c0",
      statusWarning: "#fa0",
      statusDanger: "#f33",
    },
  },
  host: { id: "local", label: "Local" },
  layout: { compact: false, platform: "web" },
};

test("client entry registers stall-recovery settings screen and cleans up cleanly", async () => {
  const { default: contributeClient } = (await import(CLIENT_ENTRY_PATH)) as {
    default: ClientContributeFn;
  };
  const registered: Array<{ id: string; icon: unknown; title: unknown; Component: unknown }> = [];
  let removed = 0;
  const cleanup = contributeClient({
    addSettingsScreen(contrib) {
      registered.push(contrib);
      return () => {
        removed++;
      };
    },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.id, "stall-recovery");
  assert.equal(registered[0]!.icon, "RefreshCw");
  assert.equal(typeof registered[0]!.Component, "function");
  await cleanup();
  assert.equal(removed, 1);
});

test("settings screen renders loading, error, and invalid states including reset failure feedback", async () => {
  const { StallRecoverySettingsScreen } = (await import(SETTINGS_SCREEN_PATH)) as {
    StallRecoverySettingsScreen: SettingsScreenComponent;
  };

  // 1) loading state renders Loading and never pretends defaults are saved.
  g.__paseoClientTestHarness = {
    locale: "en",
    toasts: [],
    settingsState: {
      status: "loading",
      saving: false,
      saveError: null,
      save: async () => false,
      reset: async () => false,
      reload: async () => {},
    },
  };
  let tree = createRenderer().render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  assert.equal(findAll(tree, (n) => n.type === "Loading").length, 1);
  assert.equal(findAll(tree, (n) => n.type === "SettingsSwitch").length, 0);

  // 2) error state shows error message and reload button.
  let reloaded = 0;
  g.__paseoClientTestHarness = {
    locale: "en",
    toasts: [],
    settingsState: {
      status: "error",
      error: "daemon disconnected",
      saving: false,
      saveError: null,
      save: async () => false,
      reset: async () => false,
      reload: async () => {
        reloaded++;
      },
    },
  };
  tree = createRenderer().render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const errActions = findAll(tree, (n) => n.type === "SettingsAction");
  assert.equal(errActions.length, 1);
  assert.equal(errActions[0]!.props.hint, "daemon disconnected");
  (errActions[0]!.props.onPress as () => void)();
  assert.equal(reloaded, 1);

  // 3) invalid state: reset success shows toast; reset failure (conflict/transport) renders saveError banner + reload.
  let resetResult = true;
  let invalidReloads = 0;
  g.__paseoClientTestHarness = {
    locale: "en",
    toasts: [],
    settingsState: {
      status: "invalid",
      revision: "rev-bad",
      error: "stallTimeoutSeconds must be >= 10",
      saving: false,
      saveError: null,
      save: async () => false,
      reset: async () => resetResult,
      reload: async () => {
        invalidReloads++;
      },
    },
  };
  const invalidRenderer = createRenderer();
  tree = invalidRenderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  assert.ok(!textContent(tree).includes("Could not reset settings"));
  const resetAction = findAll(tree, (n) => n.type === "SettingsAction")[0]!;
  await (resetAction.props.onPress as () => Promise<void>)();
  assert.equal(g.__paseoClientTestHarness.toasts.length, 1);
  assert.match(g.__paseoClientTestHarness.toasts[0]!.message, /reset to defaults/i);

  // Simulate revision conflict / transport failure during reset by invoking resetAction.
  resetResult = false;
  let resetCalls = 0;
  g.__paseoClientTestHarness.toasts = [];
  g.__paseoClientTestHarness.settingsState = {
    ...g.__paseoClientTestHarness.settingsState,
    reset: async () => {
      resetCalls++;
      g.__paseoClientTestHarness!.settingsState = {
        ...g.__paseoClientTestHarness!.settingsState,
        saveError: "Revision conflict: settings were modified on another client.",
      };
      return resetResult;
    },
  };
  tree = invalidRenderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const resetActionFail = findAll(tree, (n) => n.type === "SettingsAction")[0]!;
  await (resetActionFail.props.onPress as () => Promise<void>)();
  assert.equal(resetCalls, 1);
  assert.equal(g.__paseoClientTestHarness.toasts.length, 0, "failed reset must not show success toast");

  tree = invalidRenderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const renderedText = textContent(tree);
  assert.ok(renderedText.includes("Could not reset settings"));
  assert.ok(renderedText.includes("Revision conflict: settings were modified on another client."));
  const bannerReload = findAll(tree, (n) => n.type === "Pressable")[0]!;
  (bannerReload.props.onPress as () => void)();
  assert.equal(invalidReloads, 1);
});

test("settings screen ready state hides inputs when off, validates drafts, saves with draft revision, and handles conflict reload", async () => {
  const { StallRecoverySettingsScreen } = (await import(SETTINGS_SCREEN_PATH)) as {
    StallRecoverySettingsScreen: SettingsScreenComponent;
  };
  const renderer = createRenderer();
  const savedCalls: Array<{ values: unknown; revision: string }> = [];
  let reloads = 0;

  // Starts disabled -> only SettingsSwitch inside SettingsCard (no SettingsInput).
  g.__paseoClientTestHarness = {
    locale: "en",
    toasts: [],
    settingsState: {
      status: "ready",
      revision: "rev-1",
      values: { enabled: false, stallTimeoutSeconds: 300, maxContinuations: 3 },
      saving: false,
      saveError: null,
      save: async (values, revision) => {
        savedCalls.push({ values, revision });
        return true;
      },
      reset: async () => true,
      reload: async () => {
        reloads++;
      },
    },
  };

  let tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  assert.equal(findAll(tree, (n) => n.type === "SettingsSwitch").length, 1);
  assert.equal(findAll(tree, (n) => n.type === "SettingsInput").length, 0);

  // Toggle enabled on -> immediate save with current revision.
  const sw = findAll(tree, (n) => n.type === "SettingsSwitch")[0]!;
  await (sw.props.onValueChange as (v: boolean) => Promise<void>)(true);
  assert.deepEqual(savedCalls[0], {
    values: { enabled: true, stallTimeoutSeconds: 300, maxContinuations: 3 },
    revision: "rev-1",
  });

  // Re-render as enabled (rev-2): SettingsCard direct children are Switch, 2 Inputs, Row (no Fragment).
  g.__paseoClientTestHarness.settingsState = {
    ...g.__paseoClientTestHarness.settingsState,
    status: "ready",
    revision: "rev-2",
    values: { enabled: true, stallTimeoutSeconds: 300, maxContinuations: 3 },
  };
  tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const card = findAll(tree, (n) => n.type === "SettingsCard")[0]!;
  assert.deepEqual(
    card.children.map((c) => (typeof c === "string" ? c : c.type)),
    ["SettingsSwitch", "SettingsInput", "SettingsInput", "SettingsRow"],
  );

  // Enter invalid timeout ("5") -> error shown, save button disabled.
  const inputs = findAll(tree, (n) => n.type === "SettingsInput");
  const timeoutHandle = (inputs[0]!.props.ref as { current: { getText(): string; __replaced: string[] } }).current;
  const retriesHandle = (inputs[1]!.props.ref as { current: { getText(): string; __replaced: string[] } }).current;
  (inputs[0]!.props.onChangeText as (s: string) => void)("5");
  tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const inputsAfterInvalid = findAll(tree, (n) => n.type === "SettingsInput");
  assert.match(String(inputsAfterInvalid[0]!.props.error), /between 10 and 3600/i);
  const saveBtnInvalid = findAll(tree, (n) => n.type === "Pressable")[0]!;
  assert.equal(saveBtnInvalid.props.disabled, true);

  // Enter valid draft (450s, 5 retries) while another client advances revision to rev-3.
  (inputsAfterInvalid[0]!.props.onChangeText as (s: string) => void)("450");
  (inputsAfterInvalid[1]!.props.onChangeText as (s: string) => void)("5");
  g.__paseoClientTestHarness.settingsState = {
    ...g.__paseoClientTestHarness.settingsState,
    status: "ready",
    revision: "rev-3",
    values: { enabled: true, stallTimeoutSeconds: 200, maxContinuations: 2 },
    save: async (values, revision) => {
      savedCalls.push({ values, revision });
      return false;
    },
  };
  tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const saveBtn = findAll(tree, (n) => n.type === "Pressable")[0]!;
  assert.equal(saveBtn.props.disabled, false);
  await (saveBtn.props.onPress as () => Promise<void>)();
  // Dirty draft preserves its captured draftRevision ("rev-2") so host detects conflict!
  assert.deepEqual(savedCalls[1], {
    values: { enabled: true, stallTimeoutSeconds: 450, maxContinuations: 5 },
    revision: "rev-2",
  });

  // Render saveError banner from conflict and click reload -> resets draft & calls replaceText() with latest rev-3 values.
  g.__paseoClientTestHarness.settingsState = {
    ...g.__paseoClientTestHarness.settingsState,
    saveError: "Revision conflict",
  };
  tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  assert.ok(textContent(tree).includes("Could not save settings"));
  assert.ok(textContent(tree).includes("Revision conflict"));
  const buttons = findAll(tree, (n) => n.type === "Pressable");
  const reloadBtn = buttons[buttons.length - 1]!;
  await (reloadBtn.props.onPress as () => Promise<void>)();
  assert.equal(reloads, 1);

  // Re-render after reload clears saveError and syncs both draft state and SettingsInput refs back to rev-3 (200 / 2).
  g.__paseoClientTestHarness.settingsState = {
    ...g.__paseoClientTestHarness.settingsState,
    saveError: null,
  };
  tree = renderer.render(React.createElement(StallRecoverySettingsScreen, surfaceProps));
  const saveBtnAfterReload = findAll(tree, (n) => n.type === "Pressable")[0]!;
  assert.equal(saveBtnAfterReload.props.disabled, true);
  assert.equal(timeoutHandle.getText(), "200");
  assert.equal(retriesHandle.getText(), "2");
  assert.ok(timeoutHandle.__replaced.includes("200"));
  assert.ok(retriesHandle.__replaced.includes("2"));
});
