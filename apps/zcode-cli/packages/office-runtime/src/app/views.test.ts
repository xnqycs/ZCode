import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
it("keeps view reports separate and never picks the last writer when ambiguous", async () => {
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures")),
    parse: async () => {
      throw new Error("not needed");
    },
  });
  const session = owner.session();
  await session.report({ viewId: "first", path: "paper.pdf", at: "page:1" });
  await session.report({ viewId: "second", path: "report.docx", at: "p:1" });
  expect(session.views()).toHaveLength(2);
  expect(session.view().path).toBeNull();
  expect(session.view("first").path).toBe("paper.pdf");
  expect(session.view("second").path).toBe("report.docx");
  session.releaseView("second");
  expect(session.view().path).toBe("paper.pdf");
  await session.close();
  expect(session.views()).toEqual([]);
});

it("a report finishing after release cannot resurrect a closed viewer", async () => {
  const files = createWorkspaceFiles(resolve(import.meta.dirname, "../../fixtures"));
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const owner = createDocumentOwner({
    files: {
      ...files,
      resolve: async (input) => {
        await gate;
        return files.resolve(input);
      },
    },
    parse: async () => {
      throw new Error("not needed");
    },
  });
  const session = owner.session();
  const pending = session.report({ viewId: "closed", path: "paper.pdf" });
  session.releaseView("closed");
  release();
  await pending;
  expect(session.views()).toEqual([]);
});
