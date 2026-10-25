import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { formatMcpToolResult } from "@zcode/core";
import { build } from "esbuild";
import {
  createAgentCuaContractPlugin,
  extractFrameContract,
  extractRequestAccessContract,
  loadAgentCuaContractOverrides,
} from "../scripts/agent-cua-contracts.mjs";

const require = createRequire(import.meta.url);
const zodRoot = dirname(require.resolve("zod/package.json"));

const FRAME_CONTRACT_SOURCE = `import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "./vendor/dist-index.js";

export { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY };

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export function isOfficialCuaImageRefText(text) {
  if (typeof text !== "string") return false;
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return false;
    const ref = parsed.image_ref;
    if (!isRecord(ref)) return false;
    if (Object.keys(ref).sort().join(",") !== "actionable,frame_id,height,width") return false;
    return (
      typeof ref.frame_id === "string" &&
      ref.frame_id.length > 0 &&
      Number.isInteger(ref.width) &&
      ref.width > 0 &&
      Number.isInteger(ref.height) &&
      ref.height > 0 &&
      ref.actionable === true
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isImageBlock(block) {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0
  );
}

function isImageRefTextBlock(block) {
  return isRecord(block) && block.type === "text" && isOfficialCuaImageRefText(block.text);
}

export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index + 1 < content.length; index += 1) {
    const image = content[index];
    const imageRef = content[index + 1];
    if (isImageBlock(image) && isImageRefTextBlock(imageRef)) {
      return { image, imageRef, imageIndex: index, imageRefIndex: index + 1 };
    }
  }
  return undefined;
}

export function attestOfficialCuaFrameContent(content, expectedKind) {
  if (expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) return undefined;
  if (findOfficialCuaFrameContentPair(content) === undefined) return undefined;
  return { kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION };
}
`;

const REQUEST_ACCESS_CONTRACT_SOURCE = `export {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
  readCuaRequestAccessStatus,
} from "./vendor/dist-index.js";
`;

const VENDOR_SOURCE = `var OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode/fixture-frame-integrity";
function unrelatedBefore() {}
var CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";
var cuaRequestAccessStatusSchema = external_exports3.object({
  schemaVersion: external_exports3.literal(1),
  platform: external_exports3.literal("darwin"),
  grantOwner: external_exports3.string().trim().min(1).max(512),
  accessibility: external_exports3.enum(["granted", "stale", "denied"]),
  screenRecording: external_exports3.enum(["granted", "denied", "unknown"])
}).strict();
function readCuaRequestAccessStatus(platform, report) {
  if (platform !== "darwin") return void 0;
  const parsed = cuaRequestAccessStatusSchema.safeParse({
    schemaVersion: 1,
    platform,
    grantOwner: report.grant_owner,
    accessibility: report.accessibility,
    screenRecording: report.screen_recording
  });
  return parsed.success ? parsed.data : void 0;
}
function attachCuaRequestAccessStatusMeta(result, platform, report) {
  const status = readCuaRequestAccessStatus(platform, report);
  if (!status) return result;
  return { ...result, _meta: { ...result._meta, [CUA_REQUEST_ACCESS_STATUS_META_KEY]: status } };
}
`;

const ENTRY_SOURCE = `import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  attestOfficialCuaFrameContent,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
} from "@zcode/zcode-cua/frame-contract";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
  readCuaRequestAccessStatus,
} from "@zcode/zcode-cua/request-access-contract";
export {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  attestOfficialCuaFrameContent,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
  readCuaRequestAccessStatus,
};
`;

const CANONICAL_IMAGE_REF_TEXT = JSON.stringify({
  image_ref: { actionable: true, frame_id: "frame-1", width: 1280, height: 720 },
});

const CANONICAL_CONTENT = [
  { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
  { type: "text", text: CANONICAL_IMAGE_REF_TEXT },
];

// formatMcpToolResult 把 MCP 的 { type, data, mimeType } 改写成模型形状。
const MODEL_IMAGE_BLOCK = {
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
};

const MODEL_IMAGE_CONTENT = [
  MODEL_IMAGE_BLOCK,
  { type: "text", text: CANONICAL_IMAGE_REF_TEXT },
];

const PRODUCER_MCP_RESULT = {
  content: [
    { type: "image", data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" },
    { type: "text", text: CANONICAL_IMAGE_REF_TEXT },
    { type: "text", text: "window: main" },
  ],
  _meta: {
    "zcode/fixture-frame-integrity": { version: 1, sha256: "0".repeat(64) },
  },
};

const VALID_REQUEST_ACCESS = {
  schemaVersion: 1,
  platform: "darwin",
  grantOwner: "owner",
  accessibility: "granted",
  screenRecording: "unknown",
};

async function withCuaFixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-agent-cua-"));
  const cuaRoot = join(directory, "zcode-cua");
  try {
    await mkdir(join(cuaRoot, "vendor"), { recursive: true });
    await mkdir(join(cuaRoot, "node_modules"), { recursive: true });
    await writeFile(
      join(cuaRoot, "package.json"),
      JSON.stringify({ name: "@zcode/zcode-cua", type: "module" }),
    );
    await writeFile(
      join(cuaRoot, "frame-contract.js"),
      options.frameContract ?? FRAME_CONTRACT_SOURCE,
    );
    await writeFile(
      join(cuaRoot, "request-access-contract.js"),
      options.requestAccessContract ?? REQUEST_ACCESS_CONTRACT_SOURCE,
    );
    if (options.vendor !== null) {
      await writeFile(join(cuaRoot, "vendor", "dist-index.js"), options.vendor ?? VENDOR_SOURCE);
    }
    await symlink(zodRoot, join(cuaRoot, "node_modules", "zod"), "dir");
    await run({ directory, cuaRoot });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildContracts({ cuaRoot, plugins, nodePaths }) {
  return build({
    bundle: true,
    format: "cjs",
    logLevel: "silent",
    metafile: true,
    platform: "node",
    stdin: {
      contents: ENTRY_SOURCE,
      resolveDir: cuaRoot,
      sourcefile: "entry.js",
    },
    ...(nodePaths ? { nodePaths } : {}),
    write: false,
    plugins,
  });
}

function evaluate(result) {
  const context = { module: { exports: {} }, process, console };
  runInNewContext(result.outputFiles[0].text, context);
  return context.module.exports;
}

test("leaves the build untouched when vendor/dist-index.js is absent", async () => {
  await withCuaFixture(
    async ({ cuaRoot }) => {
      assert.equal(await loadAgentCuaContractOverrides(cuaRoot), undefined);

      const plain = await build({
        bundle: true,
        format: "cjs",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: { contents: "export const value = 1;", resolveDir: cuaRoot },
        write: false,
      });
      const overrides = await loadAgentCuaContractOverrides(cuaRoot);
      const conditional = await build({
        bundle: true,
        format: "cjs",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: { contents: "export const value = 1;", resolveDir: cuaRoot },
        write: false,
        plugins: overrides ? [createAgentCuaContractPlugin(overrides)] : [],
      });
      assert.equal(plain.outputFiles[0].text, conditional.outputFiles[0].text);
    },
    { vendor: null },
  );
});

test("derives vendor-free contracts and keeps runtime behaviour in the CJS bundle", async () => {
  await withCuaFixture(async ({ cuaRoot }) => {
    const overrides = await loadAgentCuaContractOverrides(cuaRoot);
    assert.ok(overrides);
    assert.doesNotMatch(
      overrides["@zcode/zcode-cua/frame-contract"].contents,
      /vendor\/dist-index/,
    );
    assert.match(
      overrides["@zcode/zcode-cua/frame-contract"].contents,
      /const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode\/fixture-frame-integrity";/,
    );
    assert.match(
      overrides["@zcode/zcode-cua/request-access-contract"].contents,
      /^import \{ z \} from "zod";/,
    );

    const result = await buildContracts({
      cuaRoot,
      plugins: [createAgentCuaContractPlugin(overrides)],
    });
    const text = result.outputFiles[0].text;
    assert.doesNotMatch(text, /vendor\/dist-index/);
    assert.ok(
      Object.keys(result.metafile.inputs).includes("zp-agent-cua:frame-contract"),
      "derived frame contract is part of the metafile",
    );
    assert.ok(
      Object.keys(result.metafile.inputs).includes("zp-agent-cua:request-access-contract"),
      "derived request-access contract is part of the metafile",
    );

    const contracts = evaluate(result);
    assert.equal(contracts.OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY, "zcode/fixture-frame-integrity");
    assert.equal(contracts.isOfficialCuaImageRefText(CANONICAL_IMAGE_REF_TEXT), true);
    assert.equal(contracts.isOfficialCuaImageRefText("not an image ref"), false);

    const pair = contracts.findOfficialCuaFrameContentPair(CANONICAL_CONTENT);
    assert.equal(pair.imageIndex, 0);
    assert.equal(pair.imageRefIndex, 1);
    assert.equal(pair.image, CANONICAL_CONTENT[0]);
    assert.equal(pair.imageRef, CANONICAL_CONTENT[1]);
    assert.equal(contracts.findOfficialCuaFrameContentPair([CANONICAL_CONTENT[0]]), undefined);
    assert.equal(
      contracts.attestOfficialCuaFrameContent(CANONICAL_CONTENT, "official_cua_frame_v1").kind,
      "official_cua_frame_v1",
    );
    assert.equal(contracts.attestOfficialCuaFrameContent(CANONICAL_CONTENT, "other"), undefined);
    assert.equal(contracts.attestOfficialCuaFrameContent([CANONICAL_CONTENT[0]], "official_cua_frame_v1"), undefined);

    assert.equal(contracts.CUA_REQUEST_ACCESS_STATUS_META_KEY, "zcode.cua/request-access-status-v1");
    assert.equal(contracts.cuaRequestAccessStatusSchema.safeParse(VALID_REQUEST_ACCESS).success, true);
    assert.equal(
      contracts.cuaRequestAccessStatusSchema.safeParse({
        ...VALID_REQUEST_ACCESS,
        platform: "win32",
      }).success,
      false,
    );
    assert.equal(
      contracts.cuaRequestAccessStatusSchema.safeParse({
        ...VALID_REQUEST_ACCESS,
        unexpected: true,
      }).success,
      false,
    );
    assert.equal(
      contracts.readCuaRequestAccessStatus("darwin", {
        grant_owner: "owner",
        accessibility: "granted",
        screen_recording: "unknown",
      }).grantOwner,
      "owner",
    );
  });
});

test("attests model-shaped image blocks produced by the MCP formatter", async () => {
  await withCuaFixture(async ({ cuaRoot }) => {
    const overrides = await loadAgentCuaContractOverrides(cuaRoot);
    const contracts = evaluate(
      await buildContracts({ cuaRoot, plugins: [createAgentCuaContractPlugin(overrides)] }),
    );

    const pair = contracts.findOfficialCuaFrameContentPair(MODEL_IMAGE_CONTENT);
    assert.equal(pair.imageIndex, 0);
    assert.equal(pair.imageRefIndex, 1);
    assert.equal(pair.image, MODEL_IMAGE_BLOCK);
    assert.equal(pair.imageRef, MODEL_IMAGE_CONTENT[1]);
    assert.equal(
      contracts.attestOfficialCuaFrameContent(MODEL_IMAGE_CONTENT, "official_cua_frame_v1").kind,
      "official_cua_frame_v1",
    );
  });
});

test("rejects malformed image/image_ref pairs in both shapes", async () => {
  await withCuaFixture(async ({ cuaRoot }) => {
    const overrides = await loadAgentCuaContractOverrides(cuaRoot);
    const contracts = evaluate(
      await buildContracts({ cuaRoot, plugins: [createAgentCuaContractPlugin(overrides)] }),
    );
    const imageRef = { type: "text", text: CANONICAL_IMAGE_REF_TEXT };
    const nonActionableRef = {
      type: "text",
      text: JSON.stringify({
        image_ref: { actionable: false, frame_id: "frame-1", width: 1280, height: 720 },
      }),
    };
    const malformed = [
      ["model dataUrl is empty", [{ ...MODEL_IMAGE_BLOCK, dataUrl: "" }, imageRef]],
      ["model dataUrl is not a string", [{ ...MODEL_IMAGE_BLOCK, dataUrl: 42 }, imageRef]],
      ["raw data is empty", [{ type: "image", data: "", mimeType: "image/png" }, imageRef]],
      ["raw data is not a string", [{ type: "image", data: 42, mimeType: "image/png" }, imageRef]],
      ["type is not image", [{ ...MODEL_IMAGE_BLOCK, type: "file" }, imageRef]],
      ["image_ref is not actionable", [MODEL_IMAGE_BLOCK, nonActionableRef]],
      ["image_ref has a missing key", [
        MODEL_IMAGE_BLOCK,
        {
          type: "text",
          text: JSON.stringify({
            image_ref: { actionable: true, frame_id: "frame-1", width: 1280 },
          }),
        },
      ]],
      ["next block is not an image_ref", [MODEL_IMAGE_BLOCK, { type: "text", text: "not an image ref" }]],
      ["only the image block", [MODEL_IMAGE_BLOCK]],
    ];
    for (const [label, content] of malformed) {
      assert.equal(contracts.findOfficialCuaFrameContentPair(content), undefined, label);
      assert.equal(
        contracts.attestOfficialCuaFrameContent(content, "official_cua_frame_v1"),
        undefined,
        label,
      );
    }
  });
});

test("end-to-end: the real MCP formatter output passes the derived attestation", async () => {
  const modelContent = formatMcpToolResult(PRODUCER_MCP_RESULT);
  assert.ok(Array.isArray(modelContent));
  assert.equal(modelContent[0].type, "image");
  assert.equal(typeof modelContent[0].dataUrl, "string");
  assert.equal(modelContent[0].data, undefined);

  await withCuaFixture(async ({ cuaRoot }) => {
    const overrides = await loadAgentCuaContractOverrides(cuaRoot);
    const contracts = evaluate(
      await buildContracts({ cuaRoot, plugins: [createAgentCuaContractPlugin(overrides)] }),
    );
    const pair = contracts.findOfficialCuaFrameContentPair(modelContent);
    assert.equal(pair.imageIndex, 0);
    assert.equal(pair.imageRefIndex, 1);
    assert.equal(
      contracts.attestOfficialCuaFrameContent(modelContent, "official_cua_frame_v1").kind,
      "official_cua_frame_v1",
    );
  });
});

test("frame derivation rejects a changed isImageBlock shape", () => {
  const renamed = FRAME_CONTRACT_SOURCE.replaceAll("block.data", "block.payload");
  assert.throws(
    () => extractFrameContract(renamed, VENDOR_SOURCE),
    /isImageBlock 形态变了，需要重新审视/,
  );
});

test("frame derivation rejects a duplicated isImageBlock data check", () => {
  const duplicated = FRAME_CONTRACT_SOURCE.replace(
    "function isImageBlock(block) {",
    `function isImageBlockDuplicate(block) {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0
  );
}

function isImageBlock(block) {`,
  );
  assert.throws(
    () => extractFrameContract(duplicated, VENDOR_SOURCE),
    /isImageBlock 形态变了，需要重新审视/,
  );
});

test("frame derivation rejects a missing vendor constant", () => {
  assert.throws(
    () => extractFrameContract(FRAME_CONTRACT_SOURCE, "var somethingElse = 1;"),
    /OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY/,
  );
});

test("frame derivation rejects a duplicate constant in vendor", () => {
  assert.throws(
    () => extractFrameContract(FRAME_CONTRACT_SOURCE, `${VENDOR_SOURCE}\n${VENDOR_SOURCE}`),
    /exactly one var OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY/,
  );
});

test("frame derivation rejects a second vendor import", () => {
  assert.throws(
    () =>
      extractFrameContract(
        `${FRAME_CONTRACT_SOURCE}\nimport { extra } from "./vendor/dist-index.js";\n`,
        VENDOR_SOURCE,
      ),
    /vendor dependency/,
  );
});

test("frame derivation rejects a vendor import that is not the exact expected line", () => {
  const splitImport = FRAME_CONTRACT_SOURCE.replace(
    'import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "./vendor/dist-index.js";',
    'import {\n  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,\n} from "./vendor/dist-index.js";',
  );
  assert.throws(
    () => extractFrameContract(splitImport, VENDOR_SOURCE),
    /vendor dependency/,
  );
});

test("frame derivation rejects a changed export surface", () => {
  const source = FRAME_CONTRACT_SOURCE.replace(
    "export { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY };\n",
    "",
  );
  assert.throws(() => extractFrameContract(source, VENDOR_SOURCE), /export surface/);
});

test("refuses the placeholder contract while vendor is present", async () => {
  await withCuaFixture(
    async ({ cuaRoot }) => {
      await assert.rejects(loadAgentCuaContractOverrides(cuaRoot), /placeholder/);
    },
    { frameContract: 'export * from "./placeholder/frame-contract.js";\n' },
  );
});

test("request-access derivation rejects missing block markers", () => {
  assert.throws(
    () => extractRequestAccessContract("var other = 1;"),
    /request-access start marker/,
  );
  assert.throws(
    () =>
      extractRequestAccessContract(
        'var CUA_REQUEST_ACCESS_STATUS_META_KEY = "x";\nvar cuaRequestAccessStatusSchema = z.object({});',
      ),
    /request-access end marker/,
  );
});

test("request-access derivation rejects multiple external_exports bindings", () => {
  const vendor = VENDOR_SOURCE.replace(
    '  screenRecording: external_exports3.enum(["granted", "denied", "unknown"])',
    '  screenRecording: external_exports3.enum(["granted", "denied", "unknown"]),\n  extra: external_exports4.string()',
  );
  assert.throws(() => extractRequestAccessContract(vendor), /external_exports binding/);
});

test("request-access derivation rejects a changed declaration set", () => {
  const vendor = VENDOR_SOURCE.replace(
    "function readCuaRequestAccessStatus(platform, report) {",
    "function readCuaRequestAccessStatusV2(platform, report) {",
  );
  assert.throws(() => extractRequestAccessContract(vendor), /declarations changed/);
});

test("agent bundle gate rejects vendor files pulled in by another import", async () => {
  await withCuaFixture(async ({ cuaRoot }) => {
    await writeFile(
      join(cuaRoot, "index.js"),
      'import "./vendor/dist-index.js";\nexport const runtime = "real";\n',
    );
    const overrides = await loadAgentCuaContractOverrides(cuaRoot);
    await assert.rejects(
      build({
        bundle: true,
        format: "cjs",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: {
          contents: `${ENTRY_SOURCE}\nimport "./index.js";\n`,
          resolveDir: cuaRoot,
          sourcefile: "entry.js",
        },
        write: false,
        plugins: [createAgentCuaContractPlugin(overrides)],
      }),
      /vendor entered the agent CJS bundle/,
    );
  });
});

test("derived contracts match the real ZcodePro implementation", async (t) => {
  const zcodeproDir = process.env.ZCODEPRO_DIR;
  if (!zcodeproDir) {
    t.skip("ZCODEPRO_DIR is not set; skipping the real ZcodePro contract comparison");
    return;
  }
  const cuaRoot = join(zcodeproDir, "runtimes", "zcode-cua");
  if (
    !existsSync(join(cuaRoot, "frame-contract.js")) ||
    !existsSync(join(cuaRoot, "vendor", "dist-index.js"))
  ) {
    t.skip(`ZCODEPRO_DIR (${zcodeproDir}) is not a usable ZcodePro runtime checkout`);
    return;
  }

  const overrides = await loadAgentCuaContractOverrides(cuaRoot);
  assert.ok(overrides);
  // 真实 ZcodePro 检出在仓库外，没有可向上找到的 node_modules；生产叠加后包位于
  // packages/zcode-cua，resolveDir 能直接走到仓库根。这里只补 zod 的解析路径。
  const result = await buildContracts({
    cuaRoot,
    plugins: [createAgentCuaContractPlugin(overrides)],
    nodePaths: [dirname(zodRoot)],
  });
  const text = result.outputFiles[0].text;
  assert.doesNotMatch(text, /vendor\/dist-index/);
  const derived = evaluate(result);

  const realFrame = await import(
    pathToFileURL(join(cuaRoot, "frame-contract.js")).href
  );
  const realRequestAccess = await import(
    pathToFileURL(join(cuaRoot, "request-access-contract.js")).href
  );

  assert.equal(
    derived.OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
    realFrame.OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  );
  assert.equal(
    derived.CUA_REQUEST_ACCESS_STATUS_META_KEY,
    realRequestAccess.CUA_REQUEST_ACCESS_STATUS_META_KEY,
  );
  for (const text of [
    CANONICAL_IMAGE_REF_TEXT,
    "not an image ref",
    '{"image_ref":{"actionable":false,"frame_id":"x","width":1,"height":1}}',
  ]) {
    assert.equal(
      derived.isOfficialCuaImageRefText(text),
      realFrame.isOfficialCuaImageRefText(text),
      text,
    );
  }
  const derivedPair = derived.findOfficialCuaFrameContentPair(CANONICAL_CONTENT);
  const realPair = realFrame.findOfficialCuaFrameContentPair(CANONICAL_CONTENT);
  assert.equal(derivedPair.imageIndex, 0);
  assert.equal(derivedPair.imageRefIndex, 1);
  assert.equal(derivedPair.imageIndex, realPair.imageIndex);
  assert.equal(derivedPair.imageRefIndex, realPair.imageRefIndex);
  assert.equal(
    derived.attestOfficialCuaFrameContent(CANONICAL_CONTENT, "official_cua_frame_v1").kind,
    realFrame.attestOfficialCuaFrameContent(CANONICAL_CONTENT, "official_cua_frame_v1").kind,
  );
  for (const input of [
    VALID_REQUEST_ACCESS,
    { ...VALID_REQUEST_ACCESS, platform: "win32" },
    { ...VALID_REQUEST_ACCESS, extra: true },
  ]) {
    const derivedResult = derived.cuaRequestAccessStatusSchema.safeParse(input);
    const realResult = realRequestAccess.cuaRequestAccessStatusSchema.safeParse(input);
    assert.equal(derivedResult.success, realResult.success, JSON.stringify(input));
  }
});
