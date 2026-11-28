# Better Paseo Antigravity

Paseo 内置 Antigravity ACP Provider 的稳定性与健壮性增强版。插件同样基于 Paseo 官方 ACP SDK 包装本机已登录的官方 `agy acp`，不堆砌花哨功能、不魔改协议、不碰私有数据库，专注于加固传输层、进程生命周期与状态管理，解决内置 ACP Provider 在长会话中容易出现的各类 Bug。

## 与内置 Antigravity ACP Provider 的对比

两者底层都调用官方 `agy acp` 并复用 Paseo 官方 ACP SDK，模型选择、思考档位、斜杠命令、技能、工具审批与会话恢复机制保持一致。核心区别在于：Better Paseo Antigravity 针对内置 ACP Provider 在真实长会话中常见的主动停止无响应、进程残留、报错被吞、历史回放截断、休眠误超时与工具状态错乱等问题做了系统性加固。

| 内置 Antigravity ACP Provider 常见问题 | Better Paseo Antigravity 的增强处理 |
| --- | --- |
| TCP 未断但上游 SSE 静默停吐 | 满足安全门禁后，连续静默 150 秒自动请求中断，至多进行 1 次防重续接；前台工具、审批、回放及已识别的后台挂起任务均阻止触发。续接后再次超时只停止，不再续接。 |
| 点击停止无响应或残留孤儿进程 | 显式停止请求的投递独立于阻塞的写队列并设有超时兜底；仅针对当时在途的请求、前景工具与待审批请求（包括没有活跃轮次的恢复态审批）分别设置 5 秒兜底时限，后续新请求不会继承旧超时；关闭时先执行有界的优雅 ACP 关闭，再清理独立 POSIX 进程组。 |
| 异常断连后只剩笼统报错 | 关闭流之前记录底层传输、看门狗故障原因及退出码或信号，保留真实根因诊断，不被笼统的 SDK 错误掩盖。 |
| 大历史会话恢复截断或乱序 | 以 `agy >= 1.5.15` 原生 `session/load` 响应为结束边界，完整保留分片 UTF-8 解码、消息顺序与背压处理，不再等待输出流静默；恢复后的实时更新无需再发新 prompt 即可显示。 |
| 主机休眠唤醒后触发误超时 | 识别系统休眠与时钟跳变（超过 5 秒），自动重算休眠前任务基准（包含休眠前最后一个计时周期内启动的任务），同时保留唤醒后新任务的正常超时。 |
| 前景轮次结束误清后台工具 | 前台工具行跟踪仍仅按显式工具结束事件回收；独立的恢复门禁区分普通单轮异步任务与 live 常驻 daemon／周期任务，避免混淆两者生命周期。 |
| 状态检查不校验真实版本或报错含糊 | 状态检查在共享的约 95 秒冷启动预算内校验 `agy` 版本（`>=1.5.15`）并执行真实 ACP 握手，遇到已知登录失败时返回清晰诊断且不输出授权 URL。 |

## 工作方式

新建 Agent 时选择 Better Paseo Antigravity 即可使用。不会自动迁移由 Paseo 内置 Antigravity Provider 创建的既有会话。模型选择、思考档位、斜杠命令、技能、工具审批与会话恢复均继续基于 Paseo ACP SDK 工作。Full access 模式为可选模式，默认不开启。插件绝不盲目重发原始用户 prompt；仅在静默恢复门禁全部满足时，发送一条独立、可见的防重续接提示。断连、用户 Stop 和错误不会触发自动重试。

### 为什么需要 SSE 静默恢复

现场通过 `acp-server-*.log`、`daemon.log` 及 Mihomo 实时连接表确认：TCP 保持 `ESTABLISHED` 时，Google 服务端 `daily-cloudcode-pa.googleapis.com` 的 `streamGenerateContent?alt=sse` 偶尔在输出部分思考后静默停吐，不继续输出，也不发送 `END_STREAM`；闭源 `agy` 客户端又缺少 SSE 块间空闲读超时，导致 `session/prompt` 永久挂起，Paseo 一直显示 `running`。这是 Google 服务端 SSE 停吐与 `agy` 缺少流式读超时共同造成的上游缺陷，不是本插件自身引起的 Bug。插件在外层增加默认 150 秒的安全恢复兜底，不直接调用该端点，也不绕过官方 ACP。

### 三道安全门禁

1. 仅在活跃轮次恰好有一个未返回 prompt、无前台工具、无待审批、非回放且用户未 Stop 时累计静默时间。持续 thought/text 输出重置窗口；休眠与时钟跳变重算基准。`run_command` 的后台运行提示／`IsDaemon`、`invoke_subagent`、`schedule` 会建立独立后台保护，即使启动工具已显示完成也不会解除。SDK deferred／steer 轮次不自动恢复。
2. 通过公开 `session.interrupt` 让 SDK 发送 ACP `session/cancel`，保留原有 5 秒取消兜底。等待取消投递完成、原轮 SDK `canceled` 且原生返回 `cancelled` 后，才通过公开 `session.prompt` 发送最多一次防重续接，要求基于已有工具输出及磁盘状态继续，禁止重复已成功的写入、命令或外部动作。续接再次超时只停止；用户 Stop、新消息或 transport 异常立即使待续接计划失效。每条新用户消息独立获得一次额度。
3. 成功恢复仅发两条 `session.notice`：发起中断、开始续接；正常新输出和完成只写后台日志，不额外刷通知。放弃恢复、二次超时停止等异常终态仍有提示。结构化诊断只记录标量元数据，不记录正文、思考、工具 payload、凭据或原始 stderr。

内部续接的 `session.prompt_result` 在清理 replacements、绑定轮次后由插件消费；宿主提交消息的回执、续接轮的 `session.turn` 与可见 `timeline.item` 正常透传。

启动工具完成不等于后台任务结束。普通非 daemon 后台命令、`invoke_subagent`、一次性 schedule 在本轮内保护；只有原生 `end_turn`、SDK 正常完成且无取消／替换，才在下一条用户消息开始的新轮次清理。live 启动的 `IsDaemon === true` 或带非空 `CronExpression` 的周期 schedule，跨轮保护至同调用明确数字退出码终态或 transport 关闭。历史回放不建立后台保护，旧记录不再永久屏蔽新轮次恢复；异常收尾不清空单轮挂起保护。`agy 1.5.18` 现场证据表明，普通后台命令可以经独立系统回调完成，而没有同调用数字退出码更新。ACP 未报告的后台工作、完全静默的长思考无法被可靠区分；防重提示也不是动作恰好执行一次的保证。约 120 秒的 quiet 日志仍是独立的只诊断机制。恢复流程的真实宿主／移动端 UI 验收尚待进行。

## 环境与要求

- 系统：macOS 或 Linux（依赖 POSIX 进程组信号清理，暂不支持 Windows）。
- Paseo：`>=0.17.3`。
- Antigravity CLI：守护进程所在主机已安装并登录官方 `agy` 1.5.15 及以上版本（建议使用 1.5.16，以获得官方对子代理审批与提问转发的修复）。

Provider 状态检查会在共享的约 95 秒冷启动预算内校验 `agy` CLI 版本并完成 ACP 握手，遇到已知登录失败时会返回诊断信息且不输出授权 URL。账号资格与模型权限仍在实际打开会话时校验。

权限选项通过 Paseo ACP SDK 处理。Full access 是绑定原生 default 的 SDK 自动批准模式，不等同于原生 Auto；存在歧义的允许选项（包括重复的 allow_always 类型）会回退人工审批。当前 SDK 不转发审批响应的 message/updatedInput 字段，因此不支持子代理自由文本回答；复杂原生表单仍未验证。同一原生会话内同时挂起的审批若使用相同 toolCallId，可能发生冲突。steer 仅支持 SDK 已进入 deferred 的轮次，原生后台 prompt 尚未返回时不保证可用。没有分类元数据的命令名称保持未分类，不再一律视为技能。

恢复态审批停止超时后的真实 UI 卡片收尾尚未验证。

因 Google Antigravity 的 ToS 限制要求外部客户端仅通过官方 ACP 协议接入，套餐额度查询已下线。插件仅保留 ACP Provider，不包装或后台轮询 `agy -p /usage`；待官方 ACP 开放受支持的额度能力后再考虑恢复。

## 隐私与边界

Prompt 与工具输出会通过本机官方 `agy` CLI 使用你现有的登录态发送至 Google Antigravity 服务端。插件不会创建单独的 OAuth 流程、账号目录或网络代理，不会复制或存储凭据，也不会覆盖 `GEMINI_HOME`、`SSH_*` 或 `BROWSER`。插件不读取私有的原生会话 SQLite 数据库或原始记录。旧版本已写入时间线的进度提示仍会作为历史记录保留。账号资格、速率限制与网络故障无法由插件绕过。
