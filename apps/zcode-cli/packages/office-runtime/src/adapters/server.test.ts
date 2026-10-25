import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createDocumentOwner, type Parser } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
import { PARSERS } from "#office/adapters/parsers.ts";
import { createOfficeServer } from "#office/adapters/server.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
const parse: Parser = async (file) => {
  const parser = PARSERS[file.kind];
  if (!parser) throw new Error(`no parser for ${file.kind}`);
  return parser(file.bytes, file.path, { cMapUrl: "", standardFontDataUrl: "" });
};

async function connect() {
  const owner = createDocumentOwner({ files: createWorkspaceFiles(fixtures), parse });
  const server = createOfficeServer({ owner, assetRoot: fixtures });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "office-session-test", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async (
    meta: Record<string, unknown> | undefined,
    name: string,
    arguments_: Record<string, unknown>,
  ) => {
    const result = await client.callTool({
      name,
      arguments: arguments_,
      ...(meta ? { _meta: meta } : {}),
    });
    expect(result.isError).not.toBe(true);
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };
  const current = async (meta: Record<string, unknown> | undefined) => {
    const structured = await call(meta, "get_viewer", {});
    return (structured.document as { path?: string } | null)?.path;
  };
  return {
    owner,
    client,
    server,
    call,
    current,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

it("routes tool calls to the session from _meta", async () => {
  const { call, current, close } = await connect();
  const a = { session_id: "session-a" };
  const b = { session_id: "session-b" };
  try {
    await call(a, "open_document", { path: "report.docx" });
    await call(b, "open_document", { path: "budget.xlsx" });
    expect(await current(a)).toBe("report.docx");
    expect(await current(b)).toBe("budget.xlsx");

    await call(a, "report_view", { viewId: "panel", path: "report.docx", at: "p:1" });
    const viewA = (await call(a, "get_view", {})).view as { at?: string };
    const viewB = (await call(b, "get_view", {})).view as { at?: string };
    expect(viewA.at).toBe("p:1");
    expect(viewB.at).toBeNull();

    await call(undefined, "open_document", { path: "launch.pptx" });
    expect(await current(undefined)).toBe("launch.pptx");
    expect(await current(a)).toBe("report.docx");
    expect(await current(b)).toBe("budget.xlsx");
  } finally {
    await close();
  }
});

it("understands the namespaced request context and keeps it distinct", async () => {
  const { call, current, close } = await connect();
  const nested = { "com.zcode/request-context": { session_id: "nested" } };
  try {
    await call(nested, "open_document", { path: "budget.xlsx" });
    expect(await current(nested)).toBe("budget.xlsx");
    expect(await current({ session_id: "flat" })).toBeUndefined();
  } finally {
    await close();
  }
});
