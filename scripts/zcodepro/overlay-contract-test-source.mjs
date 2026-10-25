/**
 * 叠加后写入 packages/zcode-cua/test/overlay-contract.test.ts 的源码模板。
 *
 * 单独成文件是为了让 apply-zcodepro.mjs 保持在 max-lines 限制内；模板只依赖包根文件
 * 与构建期派生脚本，不参与运行时。
 */
export const OVERLAY_CONTRACT_TEST_SOURCE = `import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attestOfficialCuaFrameContent,
  findOfficialCuaFrameContentPair,
} from "../frame-contract.js";
import { extractFrameContract } from "../../../apps/zcode-cli/packages/cli/scripts/agent-cua-contracts.mjs";

// ZcodePro 运行时由 scripts/zcodepro/apply-zcodepro.mjs 叠加生成。这里只校验包形态契约，
// 不启动真实 broker / Helper，也不依赖本机是否安装了 Computer Use 组件。
const packageRoot = join(import.meta.dirname, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("ZcodePro overlay contract", () => {
  const manifest = readJson(join(packageRoot, "package.json"));
  const runtime = manifest.zcodeCuaRuntime as
    | { schema?: unknown; windows?: { entry?: unknown; nativeAddon?: unknown } }
    | undefined;

  it("publishes a real producer with the Windows runtime contract", () => {
    expect(manifest.name).toBe("@zcode/zcode-cua");
    expect(manifest.zcodeCuaPlaceholder).toBeUndefined();
    expect(runtime?.schema).toBe(1);
    expect(Object.keys(runtime ?? {}).sort()).toEqual(["schema", "windows"]);
    expect(Object.keys(runtime?.windows ?? {}).sort()).toEqual(["entry", "nativeAddon"]);
  });

  it("points the Windows contract at files that exist in the package", () => {
    for (const relative of [runtime?.windows?.entry, runtime?.windows?.nativeAddon]) {
      expect(typeof relative).toBe("string");
      expect(existsSync(join(packageRoot, relative as string))).toBe(true);
    }
  });

  it("keeps every exported entry file on disk", () => {
    const exports = manifest.exports as Record<string, Record<string, string>>;
    for (const entry of Object.values(exports)) {
      for (const relative of Object.values(entry)) {
        expect(existsSync(join(packageRoot, relative)), relative).toBe(true);
      }
    }
  });

  it("keeps the workspace build entry point", () => {
    const scripts = manifest.scripts as Record<string, string>;
    expect(typeof scripts.build).toBe("string");
    expect(scripts.build.length).toBeGreaterThan(0);
  });

  it("attests the canonical image/image_ref frame from the real contract", () => {
    const imageRef = { actionable: true, frame_id: "frame-1", width: 1280, height: 720 };
    const content = [
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ image_ref: imageRef }) },
    ];
    expect(findOfficialCuaFrameContentPair(content)).toMatchObject({ imageIndex: 0, imageRefIndex: 1 });
    expect(attestOfficialCuaFrameContent(content, "official_cua_frame_v1")).toEqual({ kind: "official_cua_frame_v1" });
  });

  it("attests the model-shaped frame the desktop agent receives", async () => {
    // 真实 producer 契约只认 MCP 原始 { data }；桌面 agent 在 formatMcpToolResult
    // 之后拿到的是 { dataUrl }。构建期派生同时接受两种形状，这里校验派生结果。
    const derived = extractFrameContract(
      readFileSync(join(packageRoot, "frame-contract.js"), "utf8"),
      readFileSync(join(packageRoot, "vendor", "dist-index.js"), "utf8"),
    );
    const directory = mkdtempSync(join(tmpdir(), "zcode-cua-derived-"));
    try {
      const modulePath = join(directory, "frame-contract.mjs");
      writeFileSync(modulePath, derived);
      const contract = (await import(pathToFileURL(modulePath).href)) as {
        findOfficialCuaFrameContentPair: (content: unknown) => unknown;
        attestOfficialCuaFrameContent: (content: unknown, expectedKind: string) => unknown;
      };
      const content = [
        {
          type: "image",
          mediaType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
          source: {
            id: "mcp-image",
            kind: "inline",
            mimeType: "image/jpeg",
            placeholder: "MCP image",
            sizeBytes: 12,
          },
        },
        {
          type: "text",
          text: JSON.stringify({
            image_ref: { actionable: true, frame_id: "frame-1", width: 1280, height: 720 },
          }),
        },
      ];
      expect(contract.findOfficialCuaFrameContentPair(content)).toMatchObject({
        imageIndex: 0,
        imageRefIndex: 1,
      });
      expect(contract.attestOfficialCuaFrameContent(content, "official_cua_frame_v1")).toEqual({
        kind: "official_cua_frame_v1",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
`;
