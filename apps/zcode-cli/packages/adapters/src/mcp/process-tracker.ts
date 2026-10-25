const BUILTIN_NODE_REPL_SERVER_NAME = "node_repl";
const PLUGIN_MCP_NAMESPACE_PREFIX = "plugin:";

export type McpProcessSource = "builtin" | "plugin" | "custom";

/**
 * 资源管理器用的 MCP 子进程视图：只回 pid 与归属，不含任何采样值或上报字段。
 * 这里保留明文 serverName / pluginName——只在本机 host ↔ CLI 之间流转。
 */
export interface McpTrackedProcess {
  pid: number;
  serverName: string;
  mcpSource: McpProcessSource;
  pluginName?: string;
}

export interface McpProcessTracker {
  registerConnection(input: { connectionId: string; serverName: string }): void;
  recordProcessStarted(input: { connectionId: string; pid: number }): void;
  recordProcessClosed(input: { connectionId: string }): void;
  unregisterConnection(input: { connectionId: string }): void;
  listProcesses(): McpTrackedProcess[];
}

interface TrackedConnection {
  pid?: number;
  serverName: string;
}

export function createMcpProcessTracker(): McpProcessTracker {
  const connections = new Map<string, TrackedConnection>();
  return {
    registerConnection(input) {
      connections.set(input.connectionId, { serverName: input.serverName });
    },
    recordProcessStarted(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !Number.isInteger(input.pid) || input.pid <= 0) return;
      connection.pid = input.pid;
    },
    recordProcessClosed(input) {
      connections.delete(input.connectionId);
    },
    unregisterConnection(input) {
      connections.delete(input.connectionId);
    },
    listProcesses() {
      const processes: McpTrackedProcess[] = [];
      for (const connection of connections.values()) {
        if (connection.pid === undefined) continue;
        const mcpSource = resolveMcpSource(connection.serverName);
        const pluginName = resolvePluginName(connection.serverName);
        processes.push({
          mcpSource,
          pid: connection.pid,
          serverName: connection.serverName,
          ...(pluginName ? { pluginName } : {}),
        });
      }
      return processes;
    },
  };
}

/** `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined */
export function resolvePluginName(serverName: string): string | undefined {
  if (!serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)) return undefined;
  const name = serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length).split(":")[0]?.trim();
  return name ? name : undefined;
}

function resolveMcpSource(serverName: string): McpProcessSource {
  if (serverName === BUILTIN_NODE_REPL_SERVER_NAME) return "builtin";
  return serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX) ? "plugin" : "custom";
}
