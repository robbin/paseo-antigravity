import {
  type PluginSurfaceProps,
  useSettings,
  useTranslation,
} from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  MAX_CONTINUATIONS_MAX,
  MAX_CONTINUATIONS_MIN,
  STALL_RECOVERY_DEFAULTS,
  STALL_TIMEOUT_SECONDS_MAX,
  STALL_TIMEOUT_SECONDS_MIN,
  type ParseIntResult,
  type StallRecoverySettings,
  parseMaxContinuations,
  parseStallTimeoutSeconds,
  stallRecoverySettings,
} from "../shared/settings";
import { messages } from "./messages";

function SaveErrorBanner({
  theme,
  layout,
  locale,
  title,
  error,
  reloadLabel,
  disabled,
  onReload,
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  locale: string;
  title: string;
  error: string;
  reloadLabel: string;
  disabled: boolean;
  onReload(): void;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 10,
        padding: layout.compact ? 12 : 14,
        gap: 6,
      }}
    >
      <Text
        accessibilityLanguage={locale}
        style={{ color: theme.colors.statusDanger, fontSize: 13, fontWeight: "600" }}
      >
        {title}
      </Text>
      <Text
        accessibilityLanguage={locale}
        style={{ color: theme.colors.foreground, fontSize: 13 }}
      >
        {error}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onReload}
        style={{
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          paddingHorizontal: 14,
          paddingVertical: 9,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          accessibilityLanguage={locale}
          style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}
        >
          {reloadLabel}
        </Text>
      </Pressable>
    </View>
  );
}

interface ReadyViewProps extends PluginSurfaceProps {
  values: StallRecoverySettings;
  revision: string;
  saving: boolean;
  saveError: string | null;
  save(values: StallRecoverySettings, revision: string): Promise<boolean>;
  reload(): Promise<void>;
}

function ReadySettingsView({
  theme,
  layout,
  values,
  revision,
  saving,
  saveError,
  save,
  reload,
}: ReadyViewProps) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();

  const timeoutRef = useRef<SettingsInputHandle>(null);
  const retriesRef = useRef<SettingsInputHandle>(null);

  const [timeoutDraft, setTimeoutDraft] = useState(() => String(values.stallTimeoutSeconds));
  const [retriesDraft, setRetriesDraft] = useState(() => String(values.maxContinuations));
  const [draftRevision, setDraftRevision] = useState(revision);
  const [reloadSyncTick, setReloadSyncTick] = useState(0);

  const forceSyncRef = useRef(false);
  const prevSavedRef = useRef({
    enabled: values.enabled,
    stallTimeoutSeconds: values.stallTimeoutSeconds,
    maxContinuations: values.maxContinuations,
  });

  useEffect(() => {
    const prev = prevSavedRef.current;
    const prevTimeoutStr = String(prev.stallTimeoutSeconds);
    const prevRetriesStr = String(prev.maxContinuations);
    const nextTimeoutStr = String(values.stallTimeoutSeconds);
    const nextRetriesStr = String(values.maxContinuations);
    const wasClean =
      timeoutDraft.trim() === prevTimeoutStr && retriesDraft.trim() === prevRetriesStr;
    const justEnabled = !prev.enabled && values.enabled;
    const forceSync = forceSyncRef.current;

    if (forceSync || wasClean || justEnabled) {
      forceSyncRef.current = false;
      setTimeoutDraft(nextTimeoutStr);
      setRetriesDraft(nextRetriesStr);
      setDraftRevision(revision);
      timeoutRef.current?.replaceText(nextTimeoutStr);
      retriesRef.current?.replaceText(nextRetriesStr);
    }

    prevSavedRef.current = {
      enabled: values.enabled,
      stallTimeoutSeconds: values.stallTimeoutSeconds,
      maxContinuations: values.maxContinuations,
    };
  }, [
    values.enabled,
    values.stallTimeoutSeconds,
    values.maxContinuations,
    revision,
    timeoutDraft,
    retriesDraft,
    reloadSyncTick,
  ]);

  const formatValidationError = (result: ParseIntResult, min: number, max: number): string | null => {
    if (result.ok) return null;
    if (result.reason === "required") return t("errRequired");
    if (result.reason === "integer") return t("errInteger");
    return t("errRange", { min, max });
  };

  const timeoutParsed = useMemo(() => parseStallTimeoutSeconds(timeoutDraft), [timeoutDraft]);
  const retriesParsed = useMemo(() => parseMaxContinuations(retriesDraft), [retriesDraft]);

  const timeoutError = formatValidationError(
    timeoutParsed,
    STALL_TIMEOUT_SECONDS_MIN,
    STALL_TIMEOUT_SECONDS_MAX,
  );
  const retriesError = formatValidationError(
    retriesParsed,
    MAX_CONTINUATIONS_MIN,
    MAX_CONTINUATIONS_MAX,
  );

  const hasParamChanges =
    !timeoutParsed.ok ||
    !retriesParsed.ok ||
    timeoutParsed.value !== values.stallTimeoutSeconds ||
    retriesParsed.value !== values.maxContinuations;

  const canSaveParams = !saving && hasParamChanges && timeoutParsed.ok && retriesParsed.ok;
  const isDefaultParams =
    values.stallTimeoutSeconds === STALL_RECOVERY_DEFAULTS.stallTimeoutSeconds &&
    values.maxContinuations === STALL_RECOVERY_DEFAULTS.maxContinuations &&
    !hasParamChanges;

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    const ok = await save({ ...values, enabled: nextEnabled }, revision);
    if (ok) {
      toast.show(nextEnabled ? t("enabledToast") : t("disabledToast"), { variant: "success" });
    }
  };

  const handleSaveParams = async () => {
    if (!timeoutParsed.ok || !retriesParsed.ok) return;
    const nextValues: StallRecoverySettings = {
      enabled: values.enabled,
      stallTimeoutSeconds: timeoutParsed.value,
      maxContinuations: retriesParsed.value,
    };
    const ok = await save(nextValues, draftRevision);
    if (ok) {
      forceSyncRef.current = true;
      setReloadSyncTick((n) => n + 1);
      toast.show(t("savedToast"), { variant: "success" });
    }
  };

  const handleResetParams = async () => {
    const nextValues: StallRecoverySettings = {
      enabled: values.enabled,
      stallTimeoutSeconds: STALL_RECOVERY_DEFAULTS.stallTimeoutSeconds,
      maxContinuations: STALL_RECOVERY_DEFAULTS.maxContinuations,
    };
    const ok = await save(nextValues, revision);
    if (ok) {
      forceSyncRef.current = true;
      setReloadSyncTick((n) => n + 1);
      toast.show(t("resetToast"), { variant: "info" });
    }
  };

  const handleReload = async () => {
    forceSyncRef.current = true;
    await reload();
    setReloadSyncTick((n) => n + 1);
  };

  const styles = useMemo(
    () => ({
      root: {
        gap: layout.compact ? 12 : 16,
      },
      actionsRow: {
        flexDirection: (layout.compact ? "column" : "row") as "column" | "row",
        gap: 8,
        marginTop: 8,
      },
      primaryButton: {
        backgroundColor: canSaveParams ? theme.colors.accent : theme.colors.surface2,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      primaryButtonText: {
        color: canSaveParams ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      secondaryButton: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        opacity: saving || isDefaultParams ? 0.5 : 1,
      },
      secondaryButtonText: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      footerText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
      },
    }),
    [theme, layout.compact, canSaveParams, saving, isDefaultParams],
  );

  return (
    <View style={styles.root}>
      <SettingsSection title={t("sectionTitle")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("enableLabel")}
            hint={t("enableHint")}
            value={values.enabled}
            disabled={saving}
            onValueChange={(next) => void handleToggleEnabled(next)}
          />
          {values.enabled ? (
            <SettingsInput
              ref={timeoutRef}
              label={t("timeoutLabel")}
              hint={t("timeoutHint", {
                min: STALL_TIMEOUT_SECONDS_MIN,
                max: STALL_TIMEOUT_SECONDS_MAX,
                defaultValue: STALL_RECOVERY_DEFAULTS.stallTimeoutSeconds,
              })}
              initialValue={String(values.stallTimeoutSeconds)}
              placeholder={String(STALL_RECOVERY_DEFAULTS.stallTimeoutSeconds)}
              error={timeoutError}
              disabled={saving}
              onChangeText={setTimeoutDraft}
            />
          ) : null}
          {values.enabled ? (
            <SettingsInput
              ref={retriesRef}
              label={t("retriesLabel")}
              hint={t("retriesHint", {
                min: MAX_CONTINUATIONS_MIN,
                max: MAX_CONTINUATIONS_MAX,
                defaultValue: STALL_RECOVERY_DEFAULTS.maxContinuations,
              })}
              initialValue={String(values.maxContinuations)}
              placeholder={String(STALL_RECOVERY_DEFAULTS.maxContinuations)}
              error={retriesError}
              disabled={saving}
              onChangeText={setRetriesDraft}
            />
          ) : null}
          {values.enabled ? (
            <SettingsRow label={t("actionsLabel")} hint={t("actionsHint")}>
              <View style={styles.actionsRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canSaveParams }}
                  disabled={!canSaveParams}
                  onPress={() => void handleSaveParams()}
                  style={styles.primaryButton}
                >
                  <Text accessibilityLanguage={locale} style={styles.primaryButtonText}>
                    {saving ? t("savingButton") : t("saveButton")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving || isDefaultParams }}
                  disabled={saving || isDefaultParams}
                  onPress={() => void handleResetParams()}
                  style={styles.secondaryButton}
                >
                  <Text accessibilityLanguage={locale} style={styles.secondaryButtonText}>
                    {t("resetParamsButton")}
                  </Text>
                </Pressable>
              </View>
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {saveError ? (
        <SaveErrorBanner
          theme={theme}
          layout={layout}
          locale={locale}
          title={t("saveErrorTitle")}
          error={saveError}
          reloadLabel={t("reloadButton")}
          disabled={saving}
          onReload={() => void handleReload()}
        />
      ) : null}

      <Text accessibilityLanguage={locale} style={styles.footerText}>
        {t("footerNote")}
      </Text>
    </View>
  );
}

export function StallRecoverySettingsScreen(props: PluginSurfaceProps) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const settings = useSettings(stallRecoverySettings);

  if (settings.status === "loading") {
    return <Loading />;
  }

  if (settings.status === "error") {
    return (
      <SettingsSection title={t("sectionTitle")}>
        <SettingsCard>
          <SettingsAction
            label={t("loadErrorTitle")}
            hint={settings.error}
            actionLabel={t("reloadButton")}
            disabled={settings.saving}
            onPress={() => void settings.reload()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status === "invalid") {
    const handleResetDefaults = async () => {
      const ok = await settings.reset();
      if (ok) {
        toast.show(t("resetDefaultsToast"), { variant: "success" });
      }
    };
    return (
      <View style={{ gap: props.layout.compact ? 12 : 16 }}>
        <SettingsSection title={t("sectionTitle")}>
          <SettingsCard>
            <SettingsAction
              label={t("invalidTitle")}
              hint={`${t("invalidHint")} (${settings.error})`}
              actionLabel={t("resetDefaultsButton")}
              disabled={settings.saving}
              onPress={() => void handleResetDefaults()}
            />
            <SettingsAction
              label={t("reloadSavedLabel")}
              hint={t("reloadSavedHint")}
              actionLabel={t("reloadButton")}
              disabled={settings.saving}
              onPress={() => void settings.reload()}
            />
          </SettingsCard>
        </SettingsSection>
        {settings.saveError ? (
          <SaveErrorBanner
            theme={props.theme}
            layout={props.layout}
            locale={locale}
            title={t("resetErrorTitle")}
            error={settings.saveError}
            reloadLabel={t("reloadButton")}
            disabled={settings.saving}
            onReload={() => void settings.reload()}
          />
        ) : null}
      </View>
    );
  }

  return (
    <ReadySettingsView
      {...props}
      values={settings.values}
      revision={settings.revision}
      saving={settings.saving}
      saveError={settings.saveError}
      save={settings.save}
      reload={settings.reload}
    />
  );
}
