# Workspace Header Help Menu

## 行为

- 桌面端 Workspace Header、新任务草稿态和 Settings 页面复用同一个问号菜单。
- 菜单只保留桌面能力：导出日志、资源管理器、检查更新（production）、关于 ZCode。
- 产品文档、用户社群、问题上报、提交漏洞、给产品提需求入口已移除；问题上报仍可从错误横幅、任务行和反馈中心打开。
- Web 与手机远控没有剩余的桌面菜单项，不渲染问号按钮。
- 导出日志继续通过 `IPlatformService.exportLogs()` 调用主进程导出，保留进行中 toast、失败提示和系统定位行为。
- 检查更新仅 production 显示；Web/Preview 不显示。关于始终位于最后一项。

## 测试

- 单测：`packages/ui/test/workspaceHelpMenuButton.test.ts`、`workspaceHeaderActionSection.test.ts`。
- E2E：`help-menu-about.test.ts`、`resource-manager.test.ts`。
