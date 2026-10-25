/** 资源管理器共享的进程角色与样本来源类型。采样和聚合均在 desktop main 侧完成。 */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/** 进程实际运行的位置；远端 CLI / MCP 的样本自带 remote。 */
export type ProcessResourceRuntimeSurface = "local" | "remote";
