# Desktop 本地 Crash 留档

Desktop 主进程在启动早期配置 crash dump 路径，并把原始 minidump 归档到本地目录，
供用户或开发离线排查。产品遥测与远端 crash 上报已移除，本地 crashReporter 只写盘、
不上传。

## 目录结构

```
<appConfigDir>/crash/
  ├── live/        ← Electron / Crashpad 实时写入目录（`app.setPath("crashDumps")`）
  └── archive/     ← ZCode 额外保留的本地副本
```

`appConfigDir` 默认 `~/.zcode/v2/`；用户配置了自定义 `dataBaseDir` 时，路径为 `<dataBaseDir>/.zcode/v2/crash/`（依赖 `desktopEarlyDataBaseDirBootstrap` 在 crash 初始化前注入 `dataBaseDir`）。

## 本地归档保留策略

`archive/` 只用于保留原始 minidump，供线上事件不足以定位问题时离线排查；它不参与
Crashpad 采集或远端上报。为了避免历史 dump 无限占用用户磁盘，本地归档遵循以下规则：

- 最多保留最近 5 个 `.dmp`
- 除最新一个外，归档总大小不得超过 100 MiB
- 最新一个 `.dmp` 始终保留，即使它本身超过 100 MiB
- 删除旧 `.dmp` 时一并删除同名 `.dmp.json` 元数据；若元数据删除暂时失败，后续清理会识别并重试删除不存在同名普通 `.dmp` 的孤立元数据，不处理其他 JSON 文件
- 清理只作用于 `archive/`；`live/` 仍完全由 Electron Crashpad 管理

清理在每次归档完成后执行，按 `.dmp` 修改时间从新到旧保留。这样既限制历史文件累积，
又保证最近一次原生崩溃仍有本地原始现场可供分析。若最新单个 dump 本身异常巨大，目录允许
临时超过 100 MiB；这是保留最近崩溃诊断能力的有意例外，而不是严格磁盘配额。

## 启动顺序

1. `desktopEarlyDataBaseDirBootstrap`：同步读取 `setting.json` 的 `dataBaseDir`
2. `appCrashCaptureBootstrap`：配置 `crashDumps`、启动本地 crashReporter、归档上一轮残留 `.dmp`
3. `index.ts`：`app.setPath("userData")` / `sessionData` 等
4. `registerCrashEventMonitor`：renderer / 子进程崩溃后延迟归档

## 相关文件

- `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/appCrashCaptureBootstrap.ts`
- `packages/desktop/src/main/desktopCrashCapture.ts`
- `packages/desktop/src/main/index.ts`
