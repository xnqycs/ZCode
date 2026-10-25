import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "isolation-plugin";
const TRANSPORTS = {
  stdio: { type: "stdio", command: "node" },
  http: { type: "http", url: "https://mcp.example.test/mcp" },
};

// 回归原因：resolveMcpServerConfig 曾只透传 alwaysLoad/enabled/timeoutMs，manifest 与 .mcp.json
// 里的 isolation 被静默丢弃，官方文档插件的 workspace 隔离声明因此完全无效。
describe.each(["file", "manifest"] as const)("plugin MCP isolation from %s", (source) => {
  it.each([
    { label: "workspace", input: "workspace", expected: "workspace" },
    { label: "session", input: "session", expected: "session" },
    { label: "omitted", input: undefined, expected: undefined },
    { label: "unknown string", input: "global", expected: undefined },
    { label: "number", input: 1, expected: undefined },
  ])("preserves isolation ($label) for every transport", async ({ input, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-isolation-"));
    const pluginRoot = join(root, PLUGIN_NAME);
    const servers = Object.fromEntries(
      Object.entries(TRANSPORTS).map(([name, transport]) => [
        name,
        { ...transport, ...(input === undefined ? {} : { isolation: input }) },
      ]),
    );
    try {
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: PLUGIN_NAME,
          ...(source === "manifest" ? { mcpServers: servers } : {}),
        }),
      );
      if (source === "file") {
        await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
      }
      const storageRoot = join(root, "storage");
      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: { dirs: [pluginRoot], enabled: true, enabledPlugins: {}, options: {} },
        env: {},
        storageRoot,
        workingDirectory: root,
      });
      expect(outcome.diagnostics).toEqual([]);
      expect(Object.keys(outcome.mcpServers)).toHaveLength(Object.keys(TRANSPORTS).length);
      for (const [name, transport] of Object.entries(TRANSPORTS)) {
        const config = outcome.mcpServers[`plugin:${PLUGIN_NAME}:${name}`];
        expect(config?.isolation, name).toBe(expected);
        expect(config, name).toMatchObject({ type: transport.type, source: { kind: "plugin" } });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
