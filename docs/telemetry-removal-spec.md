# 遥测移除规范

> 状态：实施中。本文定义 ZCode 移除产品遥测后的范围、状态所有者、保留边界与验收场景。
> 代码、文档和测试与该规范不一致时，以本规范为准；后续如需恢复任何通道，先修改本文。

## 1. 目标

移除所有**非用户发起、离机上送**的产品与性能遥测，不改变登录、计费、反馈、远控配对、
自动更新、本地诊断和本地使用统计。

## 2. 移除范围

| 通道 | 入口 |
| --- | --- |
| ARMS RUM（main） | `@arms/rum-electron`、`appARMSBootstrap`、stability / resource / network / MCP / data-size 上报 |
| ARMS RUM（renderer） | `reportArmsCustomEvent`、`uiPerfArmsTelemetry`、`chatErrorBannerTelemetry`、`reactErrorArmsTelemetry`、`sessionOpenArmsTelemetry`、`sendFunnelArmsTelemetry`、`planUsageArmsTelemetry` |
| `/event/report` | `TelemetryCore`、`appTelemetry`、`messageTelemetry`、onboarding / automation / off-peak / coding-plan funnel、`session_create`、plugin lifecycle / usage |
| Conversation 上报 | `ConversationTelemetrySupervisor`、`ConversationTelemetryAttachment`、parity E2E |
| CLI Agent OTel | `apps/zcode-cli/packages/telemetry`、span / metric schema、打包期 OTLP 注入 |
| Host / RPC 遥测 | `host*ResourceTelemetry`、`hostNetworkTelemetry`、RPC network telemetry middleware、MCP telemetry tracker |
| 移动端中继 | web-remote-control 的 telemetry-report 转发 |

构建期 `ZCODE_ARMS_RUM_ENDPOINT`、`ZCODE_TELEMETRY_REPORT_ENDPOINT`、`ZCODE_PACKAGED_AGENT_OTEL_*`
只服务于上述通道，随代码一并移除。

## 3. 保留边界

以下不属于本次移除范围，实施时不得顺带删除：

- `deviceMid` 设备身份：`X-Device-Mid` 仍用于计费 / 额度、feedback、远控配对和自动更新。
- 本地日志、日志导出、本地 SQLite usage stats、本地 crash archive、资源管理器 UI、自动更新。
- 用户主动提交的 feedback 上传。
- 本地 TTFT 与 renderer user-action OTLP 诊断通道（仅在显式配置 `OTEL_EXPORTER_OTLP_*` 时启用）。
- E2E report 与 CI 质量指标。
- 业务 API（billing、marketing touch）。

保留的本地诊断通道不得被重新用于产品行为、性能或漏斗上报。

## 4. 状态所有者

### 4.1 deviceMid

`packages/services/src/device/deviceMid.ts` 是设备身份的**唯一生成与持久化所有者**。
磁盘文件继续使用 `telemetry-state.json`，字段继续使用 `deviceMid`；每次只补写该字段，
保留其他已有字段，避免与桌面同步 writer、CLI writer 产生多份事实。

```text
services ensureDeviceMid ─┐
desktop sync reader ──────┼─> ~/.zcode/v2/telemetry-state.json (deviceMid + lock)
CLI reader ───────────────┘
        │
        └─> buildZCodeSourceHeaders -> X-Device-Mid
```

- 三个 writer 共用同一路径、字段与锁协议。
- 已存在合法 `deviceMid` 时不写盘。
- 文件损坏或写盘失败不阻断窗口创建、模型请求或远端 server 启动。
- 删除 `lastDailyActiveDate`、`dailyActiveInFlight` 等纯遥测字段。

### 4.2 V4 对话事实

V4 `ConversationTelemetryFact` 通道保留，供 server 侧 task activity 使用；
只移除 renderer 侧汇总、`/event/report` 与 ARMS 镜像。

### 4.3 模型归因与状态

`ModelApiOperation` / `ModelApiActorKind` / `resolveModelApiCallObservation` 与
`ModelApiCallObservation.logicalCallId` 保留，继续服务 `x-zcode-session-type` 与本地 TTFT。
`ModelStatusSink` 扇出保留，只删除 OTLP status sink。

## 5. 不变量

1. 登录、登出、provider 切换、计费 / 额度查询行为不变。
2. 远端 SSH / WSL / Docker workspace 仍携带 `X-Device-Mid`。
3. feedback 仍要求并携带 `device_mid`。
4. 资源管理器仍显示本地 CPU / 内存 / 网络快照。
5. 本地 crash archive、memory 诊断日志、usage stats、日志导出不受影响。
6. 桌面 continuous 与手机 replayable 的会话投递语义不变。
7. 不新增第二套设备身份、遥测队列或事件状态。

## 6. 验收场景

1. 使用本地 HTTP sink 并设置旧 `ARM` / `OTEL` / report 端点启动桌面端，登录、发消息、
   打开设置、资源管理器、退出，sink 收不到 ARMS 或 `/event/report` 请求。
2. 远端 workspace 的 billing / balance 请求带 `X-Device-Mid`；升级前后 `deviceMid` 不变。
3. feedback 提交成功；远控配对 URL 仍带 `mid`。
4. 资源管理器有数据；crash archive 与 memory 日志仍写入；usage stats 正常。
5. CLI `zcode` 启动、对话、subagent、workflow 正常；provider 请求头 `x-zcode-session-type` 不变。
6. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`、
   `pnpm knip` 与目标单测 / E2E 通过。
7. 构建产物中不存在 `@arms/rum-electron`、`@opentelemetry`（保留的本地 TTFT 代码除外）、
   `/event/report`、`ZCODE_TELEMETRY_REPORT_ENDPOINT`。

## 7. 外部影响

删除后 ARMS 面板、告警、OTLP 凭据和历史报表不再有新数据；退役面板与凭据属于发布流程，
不在仓库内完成。历史数据保留策略由数据所有者决定。
