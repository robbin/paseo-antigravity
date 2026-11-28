import { defineTranslations } from "@getpaseo/plugin/client";

export const messages = defineTranslations({
  resources: {
    en: {
      screenTitle: "SSE Stall Recovery",
      sectionTitle: "SSE stall auto-recovery",
      enableLabel: "Enable SSE stall auto-recovery",
      enableHint:
        "Off by default to avoid interrupting long thinking turns (such as Extra High mode). When enabled, cancels silent upstream streams past the threshold and attempts deduplicated continuation under safety gates.",
      timeoutLabel: "Silence detection timeout (seconds)",
      timeoutHint:
        "Range {{min}}–{{max}} seconds (default {{defaultValue}}). Counts only eligible silence with no foreground tools, approvals, or observed background jobs. Increase further (e.g. 450–600) if Extra High thinking turns stay quiet longer.",
      retriesLabel: "Maximum continuation retries",
      retriesHint:
        "Range {{min}}–{{max}} (default {{defaultValue}}). Permits up to this many continuations per user round when substantive progress is made; zero-progress retries circuit-break immediately. Set to 0 to auto-cancel without continuing.",
      actionsLabel: "Apply parameters",
      actionsHint:
        "Changes take effect immediately for active and new sessions without reloading the plugin.",
      saveButton: "Save changes",
      savingButton: "Saving…",
      resetParamsButton: "Reset defaults (300s / 3)",
      savedToast: "SSE stall recovery settings saved.",
      resetToast: "Restored default recovery parameters (300s, 3 retries).",
      enabledToast: "SSE stall auto-recovery enabled.",
      disabledToast: "SSE stall auto-recovery disabled.",
      footerNote:
        "Stored on the selected daemon host and applied live. Turning this off immediately stops pending backoff continuations.",
      loadErrorTitle: "Failed to load settings",
      invalidTitle: "Saved settings are invalid",
      invalidHint:
        "The stored settings file did not match the expected schema and was preserved. Reset to defaults to recover.",
      reloadSavedLabel: "Reload settings",
      reloadSavedHint: "Re-read the latest settings from the daemon host.",
      reloadButton: "Reload",
      resetDefaultsButton: "Reset to defaults",
      resetDefaultsToast: "Settings reset to defaults.",
      saveErrorTitle: "Could not save settings",
      resetErrorTitle: "Could not reset settings",
      errRequired: "Enter a whole number.",
      errInteger: "Must be a whole number without decimals.",
      errRange: "Must be between {{min}} and {{max}}.",
    },
    "zh-CN": {
      screenTitle: "SSE 静默恢复",
      sectionTitle: "SSE 静默自动恢复",
      enableLabel: "开启 SSE 静默自动恢复",
      enableHint:
        "默认关闭，避免误中断 Extra High 等长时间深度思考的任务。开启后，满足安全门禁且连续静默超过检测时间时，将自动中断并尝试防重续接。",
      timeoutLabel: "静默检测时间（秒）",
      timeoutHint:
        "范围 {{min}}–{{max}} 秒（默认 {{defaultValue}} 秒）。仅累计无前台工具、无待审批、无已识别后台任务时的静默时间；如 Extra High 深度思考静默更久，可继续调大（如 450–600 秒）。",
      retriesLabel: "最大续接重试次数",
      retriesHint:
        "范围 {{min}}–{{max}} 次（默认 {{defaultValue}} 次）。每轮有实质进展时按指数退避最多续接该次数，零进展会立即熔断停止；设为 0 表示仅自动中断、不自动续接。",
      actionsLabel: "应用参数",
      actionsHint: "保存后立即对当前与新建会话生效，无需重载插件。",
      saveButton: "保存更改",
      savingButton: "保存中…",
      resetParamsButton: "恢复默认参数（300 秒 / 3 次）",
      savedToast: "SSE 静默恢复设置已保存。",
      resetToast: "已恢复默认参数（300 秒、重试 3 次）。",
      enabledToast: "已开启 SSE 静默自动恢复。",
      disabledToast: "已关闭 SSE 静默自动恢复。",
      footerNote:
        "配置保存在当前守护进程主机并实时生效；关闭开关后会立即取消等待退避中的自动续接。",
      loadErrorTitle: "加载设置失败",
      invalidTitle: "已保存的设置无效",
      invalidHint:
        "磁盘上的设置文件不符合当前格式，原文件已保留。可点击恢复默认设置以修复。",
      reloadSavedLabel: "重新加载设置",
      reloadSavedHint: "从守护进程主机重新读取最新设置。",
      reloadButton: "重新加载",
      resetDefaultsButton: "恢复默认设置",
      resetDefaultsToast: "已恢复默认设置。",
      saveErrorTitle: "保存设置失败",
      resetErrorTitle: "恢复默认设置失败",
      errRequired: "请输入整数。",
      errInteger: "请输入不含小数的整数。",
      errRange: "请输入 {{min}} 到 {{max}} 之间的整数。",
    },
  },
});
