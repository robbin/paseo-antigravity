# ACP 停止兜底与静默诊断方案

## 定版与目标

Friday 汇总氖元素、搬砖工两份只读审核后定版（基线 b97ff1d，v0.3.3）。修复已复现的输入背压取消漏洞，并使无响应可诊断。不认定它是用户 Gemini 4 Carbon high 故障根因。不自动重发、不自动重连、不因静默终止、不旁路写 stdin、不修改模型设置、不读取原生数据库或保存原始 stderr。不升级依赖、不发布、不重载运行中插件。

## 取消状态机

### 两阶段期限

1. 新增本地停止请求凭证，独立于 ACP/SDK 写队列。Provider 接到显式 session.interrupt，捕获当前 transport 和可取消工作快照。可取消工作包括当前活跃 turn、未返回的 wire prompt、非 detached 工具、待审批；不能只看 turn。
2. 凭证使用内部代际 token，关联宿主 requestId 只用于匹配 request.completed/request.failed，不写日志自由文本。只为有可取消工作的显式 Stop 建立。可在 core.send 前建立临时凭证并在准入拒绝时精确回滚，或准入成功后激活原快照；必须处理 request.completed 先于 send.then 的竞争。不能在 .then 中重新针对新 turn 取快照。
3. 第一阶段最多 limits.cancel（默认 5 秒）等待该 Stop 的 SDK 请求结算。SDK 0.17.3 普通 interrupt 在 cancel 写调用完成后才发 request.completed；这可作为本地传输阶段完成信号，绝非 CLI 已读/执行确认。request.failed/准入拒绝释放对应凭证，保留既有传输故障处理。
4. 第二阶段完全保留现有 wire session/cancel 在 sink 入口快照三张 cancel 表的时序和按目标解除规则。第一阶段不提前写入这些表；因此排队接近 5 秒后才进入 sink 的取消仍有原来的收尾窗口。文档不能宣称从点击到所有情况完成总共恒为 5 秒。
5. 同一停止请求不能因重复 Stop 延期；多个有效请求保留最早未结算期限。凭证不随 turn ended/startTurn 清空，防止旧 turn 结束掩盖未完成的取消写入；但凭证仅跟随旧 Stop，请求结算/拒绝/transport 关闭会精确释放，不能污染新 transport。requestId 冲突/拒绝回滚不能删掉他人的旧凭证，内部 token 身份必须明确。
6. 空闲 Stop 不武装新兜底，不把普通替换 prompt 或 steer 当作 Stop。仍未 dispatch、尚无 turn/wire目标的排队 prompt 不在本次新增兜底保证范围；保留 SDK 行为并明确记录，而不是猜测或取消未来工作。Stop 后到达的工作不自动继承旧目标期限；旧取消调用仍未完成时关闭共享 transport 是明确边界。
7. 第一阶段超时走 transport.fail → recordFailure → controller.error/幂等 owned close → POSIX 进程组清理。文案使用“停止请求未能及时完成传输，已关闭本会话进程；未重发消息”，不推断 CLI 是否读取或服务端故障。所有新停止时钟纳入 suspend/clock rollback rebasing。

### 写入与关闭

保持一个 serial sink，不旁路写入。追踪 pending write 的内部 seq、白名单 method class、开始时间与完成状态。Node 写入 callback 完成只说明本地写调用完成，不代表 CLI 接收或处理。

在本地 fail/owned close 路径主动结算挂起 write，并及时销毁 stdin，不等待 writer.close/abort 排队完成；回调迟到不能覆盖首个 failure、重复结算或复活状态。保留 stdout EOF/EPIPE 的排队帧排空策略，普通 EPIPE 仍走 drainThenClose。进程组回收仍有 grace，finished 与清理幂等。不要声称仅修改 WritableStream sink.abort 就能解除 Web Streams 的在飞 write 阻塞。

## 诊断

- 不改旧 prompt-end/turn-end 字段；改成显式 allowlist 构造，新增字段放独立结构。
- 新增 stop 生命周期日志和 quiet 快照，不为正常每个帧/每个 prompt 输出流水账。
- 活跃 turn 连续约 120 秒没有 live 入站活动或成功本地写入，最多发一次 quiet 日志；不发 timeline notice、不 kill、不自动补发。后续正常输出继续透传。
- 标量字段建议：内部关联序号、turn/session标识（既有安全边界）、turn年龄、pending write分类/年龄、最近写入完成/首末live入站年龄、实时openPrompts、promptResponses、live文本/思考/工具/审批/压缩事件计数与未完成工具/审批数量。仅记录实际可观察信号，不断言SDK内部deferred或上游状态。实现保持最小必要字段，不为新增诊断引入完整跨层请求历史缓存。
- 同turn steer再次发prompt时openPrompts必须反映仍有请求，不能用曾经settled的粘性boolean。回放不计入live诊断。旧工具延续要按现有owner区分。
- 禁止正文、思考、工具名/参数/结果、路径、环境、原始错误、stderr和未知method字符串进入新增日志；methods按白名单分类，未知为other。隐私承诺仅针对插件自建诊断，不承诺过滤所有SDK原生错误。
- quiet阈值可测试注入但保持现有Limits调用兼容；有限正数校验、短阈值轮询、休眠与时钟回跳必须覆盖。状态随transport关闭释放。

## 测试门槛

先红后绿证明真实固定SDK/provider + mock CLI在握手/session ready后停止读stdin，足够大prompt阻塞，再发Stop：原版本无法有界结束，新版本必须runtime failure/根因可见、pending promises结算、进程组回收。测试不访问真实账户。

必须覆盖：

- 恢复读取且在第一阶段期限内完成写入的正常取消，不误杀；注意期限后仍不读被终止属于预期。
- 重复/空闲Stop、准入拒绝、request先结算竞争、正常完成与Stop竞争、旧turn结束但Stop仍堵、新turn/新transport不继承凭证。
- 恢复审批、取消中新审批、deferred follow-up保留工具、不把替换prompt当Stop；deferred + blocked steer + Stop的关闭收敛。
- close幂等、pending write及finished结算、无unhandled rejection、SIGTERM忽略后的回收。
- EPIPE尾帧、慢消费者、UTF-8、回放既有回归不退化。
- quiet无输出/thinking-only/tool-only/原生返回但仍有turn/同turn steer/compaction、回放隔离、每轮最多一次、休眠rebasing、诊断之后继续正常输出。
- 隐私哨兵与精确schema、日志计数断言同步调整。

全量 pnpm typecheck、pnpm test、git diff --check；计时关键用例重复运行。保留测试实测与未验证边界，不将模拟通过写成真实模型事故已解决。

## 文档与交付

README/VALIDATION 解释可观察的四类线索：本地写未完成、wire prompt未返回、wire已返回但turn仍在、空结束。恢复流程：记录状态 → Stop → 必要时重新打开/恢复会话 → 核对工具副作用 → 用户明确继续。补发消息可能自己排队，不是可靠恢复操作。提交/合并不代表运行中插件已更新。

实现位于独立 fix/acp-stall-recovery worktree。Friday 验证与集成，老法师只读 code review，通过且阻断项修完后本地提交、ff-only 合并 main、清理本次 worktree/分支/临时进度。不推送、不发布、不变更运行中环境。
