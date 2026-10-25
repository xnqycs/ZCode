import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "../../../..");
// 叠加态才需要这条冒烟：占位包没有 vendor，也不会内联官方服务代码。
// 手动运行：ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64 pnpm zcodepro:apply -- --zcodepro <dir>
// 然后 pnpm --filter @zcode/node-repl-host test test/vendor-embed-smoke.test.ts
const overlayVendorPath = join(repoRoot, "packages", "zcode-cua", "vendor", "dist-index.js");
const buildTimeoutMs = 120_000;

// 在宿主与 MCP 客户端之间加一层 tee，把服务端 stdout 原样落到文件；用于证明每个请求
// 只收到一条响应（重复的 serveStdio 实例会写出两条相同 id 的响应）。
const teeWrapperSource = `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const child = spawn(process.execPath, [process.argv[2]], { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.on("data", (chunk) => {
  appendFileSync(process.env.ZCODE_PROBE_LOG, chunk);
  process.stdout.write(chunk);
});
child.stderr.pipe(process.stderr);
process.stdin.on("end", () => child.stdin.end());
process.on("exit", () => child.kill());
`;

describe.skipIf(!existsSync(overlayVendorPath))(
  "overlaid node_repl bundle (requires Zcodepro overlay)",
  () => {
    let directory = "";
    let outfile = "";
    let wrapperPath = "";
    let responsesPath = "";
    let counterPath = "";

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "zcode-vendor-embed-smoke-"));
      outfile = join(directory, "server.mjs");
      wrapperPath = join(directory, "tee-wrapper.mjs");
      responsesPath = join(directory, "responses.log");
      counterPath = join(directory, "exec-count");
      await writeFile(wrapperPath, teeWrapperSource);
      await buildNodeReplHostBundle({ outfile, cuaHelperBuildId: "" });
    }, buildTimeoutMs);

    afterAll(async () => {
      if (directory) await rm(directory, { force: true, recursive: true });
    });

    it(
      "starts exactly one MCP server and executes each js call once",
      async () => {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [wrapperPath, outfile],
          cwd: directory,
          env: { ...process.env, ZCODE_PROBE_LOG: responsesPath },
          stderr: "pipe",
        });
        let serverStderr = "";
        transport.stderr?.setEncoding("utf8");
        transport.stderr?.on("data", (chunk: string) => {
          serverStderr += chunk;
        });
        const client = new Client(
          { name: "node-repl-vendor-embed-smoke", version: "0.1.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        try {
          await client.connect(transport);
          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["js"]);

          const result = await client.callTool({
            name: "js",
            arguments: {
              code: `require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "x\\n"); "counted";`,
              title: "验证单次执行",
            },
            _meta: {
              "com.zcode/request-context": {
                runtime_scope: "main",
                session_id: "vendor-embed-smoke",
              },
            },
          });
          expect(result.isError).not.toBe(true);
          expect(result.content).toContainEqual(
            expect.objectContaining({ type: "text", text: expect.stringContaining("counted") }),
          );
        } finally {
          await client.close();
        }

        const responseLines = (await readFile(responsesPath, "utf8"))
          .split("\n")
          .filter((line) => line.trim());
        const responseCounts = new Map<unknown, number>();
        for (const line of responseLines) {
          const message = JSON.parse(line) as { id?: unknown };
          responseCounts.set(message.id, (responseCounts.get(message.id) ?? 0) + 1);
        }
        // 现代协议握手只有 discover + tools/list + tools/call 三条响应；关键是每个 id
        // 只能出现一次——重复的 serveStdio 实例会写出两条相同 id 的响应。
        expect(responseCounts.size).toBeGreaterThanOrEqual(3);
        expect([...responseCounts.values()].every((value) => value === 1)).toBe(true);

        const executions = (await readFile(counterPath, "utf8"))
          .split("\n")
          .filter((line) => line.length > 0);
        expect(executions).toHaveLength(1);
        expect(serverStderr).toBe("");
      },
      buildTimeoutMs,
    );
  },
);
