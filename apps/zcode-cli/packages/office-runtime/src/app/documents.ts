import { randomUUID } from "node:crypto";
import {
  FILE_CHUNK_BYTES,
  OfficeError,
  type DocKind,
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type Selection,
  type ShowTarget,
  type ViewerSnapshot,
  type ViewState,
} from "#office/contract.ts";
import { formatLocator, parseLocator, splitAnchor } from "#office/domain/anchor.ts";
import type { Hit, ParsedDocument, ReadPage } from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import type { LoadedFile, WorkspaceFiles } from "#office/adapters/files.ts";
import { DEFAULT_SESSION, MAX_SESSIONS } from "#office/session.ts";

export type Parser = (file: LoadedFile) => Promise<ParsedDocument>;

interface Entry {
  file: LoadedFile;
  fingerprint: string;
  parsed: Promise<ParsedDocument>;
}

interface Handle {
  bytes: Uint8Array;
  path: string;
  revision: string;
}

/** Engine-only view of one session's state (`load_document` tokens included). */
export interface DocumentSession {
  /** The key this session is stored under; also owns the session's file imports. */
  readonly id: string;
  info(path: string): Promise<DocumentInfo>;
  open(path: string, at?: string | null): Promise<ViewerSnapshot>;
  show(targets: { anchor: string; quote?: string }[], note?: string): Promise<ViewerSnapshot>;
  read(
    anchor: string,
    cursor?: number,
  ): Promise<{ info: DocumentInfo; at: string | null; page: ReadPage }>;
  search(path: string, query: string, limit: number): Promise<{ info: DocumentInfo; hits: Hit[] }>;
  load(path: string): Promise<{ info: DocumentInfo; file: FileHandle; blocks?: DocxBlockKey[] }>;
  report(input: {
    viewId?: string;
    path: string;
    at?: string | null;
    selection?: Selection | null;
  }): Promise<ViewState>;
  views(): ({ viewId: string } & ViewState)[];
  releaseView(viewId: string): void;
  view(viewId?: string): ViewState;
  current(): DocumentInfo | null;
  snapshot(): ViewerSnapshot;
  close(): ViewerSnapshot;
  list(limit?: number): Promise<{ path: string; kind: DocKind; bytes: number; mtimeMs: number }[]>;
  /** Drop this session's handles when the session itself is evicted. */
  dispose(): void;
}

/** Process-wide owner shared by every session in a workspace-isolated MCP server. */
export interface DocumentOwner {
  session(id?: string): DocumentSession;
  chunk(token: string, index: number): string;
}

const MAX_CACHED = 6;
const MAX_HANDLES = 4;

/**
 * Owns everything the viewer knows: parsed documents (cached by path and revision), file handles
 * the panel reads bytes through, and one viewer state per MCP session. Server tools and the panel
 * only go through this owner.
 */
export function createDocumentOwner({
  files,
  parse,
}: {
  files: WorkspaceFiles;
  parse: Parser;
}): DocumentOwner {
  const cache = new Map<string, Entry>();
  const handles = new Map<string, Handle>();
  const sessions = new Map<string, DocumentSession>();

  async function entry(input: string): Promise<Entry> {
    const { path } = await files.resolve(input);
    const fingerprint = await files.fingerprint(path);
    const cached = cache.get(path);
    if (cached && cached.fingerprint === fingerprint) {
      cache.delete(path);
      cache.set(path, cached);
      return cached;
    }
    const file = await files.load(path);
    const fresh: Entry = { file, fingerprint, parsed: parse(file) };
    fresh.parsed.catch(() => cache.delete(path));
    cache.set(path, fresh);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return fresh;
  }

  async function document(input: string) {
    const item = await entry(input);
    return { file: item.file, doc: await item.parsed };
  }

  const describe = (file: LoadedFile, doc: ParsedDocument): DocumentInfo => ({
    path: file.path,
    kind: file.kind,
    title: doc.title,
    bytes: file.bytes.byteLength,
    revision: file.revision,
    units: doc.units,
    outline: doc.outline,
  });

  /** Validate and normalise a locator for a document; returns its canonical text. */
  function canonical(doc: ParsedDocument, at: string): string {
    return formatLocator(doc.check(parseLocator(doc.kind, at)));
  }

  /** One MCP session's viewer state; `session()` below keeps at most {@link MAX_SESSIONS}. */
  function createSession(id: string): DocumentSession {
    let current: DocumentInfo | null = null;
    let disposed = false;
    const emptyView = (): ViewState => ({
      path: null,
      kind: null,
      at: null,
      selection: null,
      updatedAt: 0,
    });
    const views = new Map<string, ViewState>();
    const reports = new Map<string, number>();
    const tokens = new Set<string>();
    let sequence = 0;
    let revealSeq = 0;

    function snapshot(reveal?: { targets: ShowTarget[]; note?: string }): ViewerSnapshot {
      return {
        document: current,
        ...(reveal ? { reveal: { ...reveal, seq: ++revealSeq } } : {}),
      };
    }

    return {
      /** The key this session is stored under; also owns the session's file imports. */
      id,

      async info(path: string): Promise<DocumentInfo> {
        const { file, doc } = await document(path);
        return describe(file, doc);
      },

      /** Make `path` the viewer's document, optionally revealing a location in it. */
      async open(path: string, at?: string | null): Promise<ViewerSnapshot> {
        const { file, doc } = await document(path);
        const target = at ? canonical(doc, at) : null;
        current = describe(file, doc);
        return snapshot(target ? { targets: [{ at: target }] } : undefined);
      },

      /** Point the user at one or more places in one document; opens it if needed. */
      async show(
        targets: { anchor: string; quote?: string }[],
        note?: string,
      ): Promise<ViewerSnapshot> {
        if (!targets.length)
          throw new OfficeError("invalid_anchor", "Give at least one anchor to show.");
        const split = targets.map((target) => ({
          ...splitAnchor(target.anchor),
          quote: target.quote,
        }));
        const path = split[0].path;
        const { path: resolved } = await files.resolve(path);
        for (const item of split) {
          if ((await files.resolve(item.path)).path !== resolved)
            throw new OfficeError(
              "invalid_anchor",
              "All anchors passed to show must be in the same document.",
            );
        }
        const { file, doc } = await document(resolved);
        const resolvedTargets = split.map((item) => ({
          at: item.at ? canonical(doc, item.at) : defaultAt(doc),
          ...(item.quote?.trim() ? { quote: cut(item.quote.trim(), 0, 500) } : {}),
        }));
        current = describe(file, doc);
        return snapshot({
          targets: resolvedTargets,
          ...(note?.trim() ? { note: cut(note.trim(), 0, 500) } : {}),
        });
      },

      async read(
        anchor: string,
        cursor = 0,
      ): Promise<{ info: DocumentInfo; at: string | null; page: ReadPage }> {
        const { path, at } = splitAnchor(anchor);
        const { file, doc } = await document(path);
        const locator = at ? doc.check(parseLocator(doc.kind, at)) : null;
        return {
          info: describe(file, doc),
          at: locator ? formatLocator(locator) : null,
          page: doc.read(locator, cursor),
        };
      },

      async search(
        path: string,
        query: string,
        limit: number,
      ): Promise<{ info: DocumentInfo; hits: Hit[] }> {
        if (!query.trim()) throw new OfficeError("invalid_anchor", "The search query is empty.");
        const { file, doc } = await document(path);
        return { info: describe(file, doc), hits: doc.search(query.trim(), limit) };
      },

      /** Panel only: load bytes for rendering and hand out a token to read them in chunks. */
      async load(
        path: string,
      ): Promise<{ info: DocumentInfo; file: FileHandle; blocks?: DocxBlockKey[] }> {
        const { file, doc } = await document(path);
        // 会话在解析期间被淘汰时不能把句柄留给已经无人持有的会话。
        if (disposed)
          throw new OfficeError(
            "invalid_token",
            "This viewer session was reset; reload the document.",
          );
        const token = randomUUID();
        handles.set(token, { bytes: file.bytes, path: file.path, revision: file.revision });
        tokens.add(token);
        while (tokens.size > MAX_HANDLES) {
          const oldest = tokens.values().next().value!;
          tokens.delete(oldest);
          handles.delete(oldest);
        }
        return {
          info: describe(file, doc),
          file: {
            token,
            bytes: file.bytes.byteLength,
            chunks: Math.max(1, Math.ceil(file.bytes.byteLength / FILE_CHUNK_BYTES)),
          },
          ...(doc.blocks ? { blocks: doc.blocks } : {}),
        };
      },

      /** Panel only: record where the user is. The path must be the panel's current document. */
      async report(input: {
        viewId?: string;
        path: string;
        at?: string | null;
        selection?: Selection | null;
      }): Promise<ViewState> {
        const viewId = input.viewId ?? "legacy";
        const ticket = ++sequence;
        reports.set(viewId, ticket);
        const { path, kind } = await files.resolve(input.path);
        const clip = (text: string) => cut(text, 0, 2000);
        const view: ViewState = {
          path,
          kind,
          at: input.at ? cut(input.at, 0, 300) : null,
          selection: input.selection?.at
            ? { at: cut(input.selection.at, 0, 300), text: clip(input.selection.text ?? "") }
            : null,
          updatedAt: Date.now(),
        };
        // 多窗口不能共用最后写者；上报也不应修改 Agent 专用 surface 的当前文档。
        // 旧上报完成时不能覆盖新上报，也不能重新创建已释放的窗口。
        if (reports.get(viewId) !== ticket) return views.get(viewId) ?? emptyView();
        views.set(viewId, view);
        return view;
      },

      views: () => [...views].map(([viewId, view]) => ({ viewId, ...view })),
      releaseView: (viewId: string) => {
        reports.delete(viewId);
        views.delete(viewId);
      },
      view: (viewId?: string) =>
        viewId
          ? (views.get(viewId) ?? emptyView())
          : views.size === 1
            ? views.values().next().value!
            : emptyView(),
      current: () => current,
      snapshot: () => snapshot(),
      close() {
        current = null;
        reports.clear();
        views.clear();
        return snapshot();
      },
      list: (limit?: number) => files.list({ limit }),

      /** Drop this session's handles when the session itself is evicted. */
      dispose() {
        disposed = true;
        for (const token of tokens) handles.delete(token);
        tokens.clear();
      },
    };
  }

  return {
    /**
     * The viewer state of one MCP session; calls without an id share {@link DEFAULT_SESSION}.
     * Refreshes the entry on access and keeps the {@link MAX_SESSIONS} most recently used sessions.
     */
    session(id?: string) {
      const key = id?.trim() || DEFAULT_SESSION;
      let state = sessions.get(key);
      if (state) sessions.delete(key);
      else state = createSession(key);
      sessions.set(key, state);
      while (sessions.size > MAX_SESSIONS) {
        const [oldest, dropped] = sessions.entries().next().value!;
        sessions.delete(oldest);
        dropped.dispose();
      }
      return state;
    },

    /** Panel only: one chunk of a loaded file. Tokens are unique across sessions. */
    chunk(token: string, index: number): string {
      const handle = handles.get(token);
      if (!handle)
        throw new OfficeError("invalid_token", "This file handle expired; reload the document.");
      const start = index * FILE_CHUNK_BYTES;
      if (!Number.isInteger(index) || index < 0 || (start >= handle.bytes.byteLength && index > 0))
        throw new OfficeError("invalid_token", "Chunk index out of range.");
      return Buffer.from(handle.bytes.subarray(start, start + FILE_CHUNK_BYTES)).toString("base64");
    },
  };
}

function defaultAt(doc: ParsedDocument): string {
  switch (doc.kind) {
    case "pdf":
      return "page:1";
    case "pptx":
      return "slide:1";
    case "docx":
      return "p:1";
    case "xlsx":
      return doc.outline[0]?.at ?? "Sheet1";
  }
}
