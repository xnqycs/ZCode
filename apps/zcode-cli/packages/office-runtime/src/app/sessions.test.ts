import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDocumentOwner, type Parser } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
import { PARSERS } from "#office/adapters/parsers.ts";
import { DEFAULT_SESSION, MAX_SESSIONS } from "#office/session.ts";

const root = resolve(import.meta.dirname, "../../fixtures");
const parse: Parser = async (file) => {
  const parser = PARSERS[file.kind];
  if (!parser) throw new Error(`no parser for ${file.kind}`);
  return parser(file.bytes, file.path, { cMapUrl: "", standardFontDataUrl: "" });
};

function owner(parser: Parser = parse) {
  return createDocumentOwner({ files: createWorkspaceFiles(root), parse: parser });
}

it("keeps the open document and snapshot separate per session", async () => {
  const documents = owner();
  const a = documents.session("session-a");
  const b = documents.session("session-b");

  expect((await a.open("report.docx")).document?.path).toBe("report.docx");
  expect((await b.open("budget.xlsx")).document?.path).toBe("budget.xlsx");
  expect(a.current()?.path).toBe("report.docx");
  expect(b.current()?.path).toBe("budget.xlsx");
  expect(a.snapshot().document?.path).toBe("report.docx");
  expect(b.snapshot().document?.path).toBe("budget.xlsx");

  await a.close();
  expect(a.current()).toBeNull();
  expect(b.current()?.path).toBe("budget.xlsx");
});

it("keeps panel views and releases separate per session", async () => {
  const documents = owner();
  const a = documents.session("session-a");
  const b = documents.session("session-b");

  await a.report({ viewId: "panel", path: "report.docx", at: "p:1" });
  await b.report({ viewId: "panel", path: "budget.xlsx", at: "Revenue!B2" });
  expect(a.views()).toEqual([
    {
      viewId: "panel",
      path: "report.docx",
      kind: "docx",
      at: "p:1",
      selection: null,
      updatedAt: expect.any(Number),
    },
  ]);
  expect(a.view("panel").path).toBe("report.docx");
  expect(b.view("panel").path).toBe("budget.xlsx");

  a.releaseView("panel");
  expect(a.views()).toEqual([]);
  expect(b.view("panel").path).toBe("budget.xlsx");
});

it("merges calls without an id into the default session", async () => {
  const documents = owner();
  const implicit = documents.session(undefined);
  const blank = documents.session("");
  const named = documents.session(DEFAULT_SESSION);

  expect(implicit).toBe(blank);
  expect(blank).toBe(named);
  await implicit.report({ viewId: "legacy", path: "report.docx", at: "p:1" });
  expect(named.views()).toHaveLength(1);
});

it("evicts the least recently used session and invalidates its handles", async () => {
  const documents = owner();
  const first = documents.session("first");
  const token = (await first.load("report.docx")).file.token;

  for (let index = 0; index < MAX_SESSIONS - 1; index += 1)
    documents.session(`keep-${index}`);
  documents.session("first"); // refresh first before the next admission
  documents.session("extra"); // evicts keep-0, not first
  expect(documents.chunk(token, 0)).not.toBe("");

  for (let index = 0; index < MAX_SESSIONS; index += 1) documents.session(`late-${index}`);
  expect(() => documents.chunk(token, 0)).toThrowError(/expired/);
});

it("shares the parse cache while keeping handle tokens unique per session", async () => {
  let parses = 0;
  const documents = owner(async (file) => {
    parses += 1;
    return parse(file);
  });
  const a = documents.session("session-a");
  const b = documents.session("session-b");

  await a.open("report.docx");
  await b.open("report.docx");
  expect(parses).toBe(1);

  const first = (await a.load("report.docx")).file.token;
  const second = (await b.load("report.docx")).file.token;
  expect(first).not.toBe(second);
  expect(documents.chunk(first, 0)).toBe(documents.chunk(second, 0));
});

it("keeps the per-session handle limit of four", async () => {
  const documents = owner();
  const session = documents.session("session-a");
  const tokens: string[] = [];
  for (let index = 0; index < 5; index += 1)
    tokens.push((await session.load("report.docx")).file.token);

  expect(() => documents.chunk(tokens[0]!, 0)).toThrowError(/expired/);
  expect(documents.chunk(tokens[4]!, 0)).not.toBe("");
});
