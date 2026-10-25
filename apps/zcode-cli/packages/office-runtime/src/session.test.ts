import { expect, it } from "vitest";
import { DEFAULT_SESSION, MAX_SESSIONS, sessionIdOf } from "#office/session.ts";

it("reads the session id from flat request metadata", () => {
  expect(sessionIdOf({ session_id: "session-a" })).toBe("session-a");
});

it("prefers root_session_id over session_id, as the official build does", () => {
  expect(sessionIdOf({ session_id: "child", root_session_id: "root" })).toBe("root");
});

it("falls back to com.zcode/request-context when the top level has no id", () => {
  expect(
    sessionIdOf({ "com.zcode/request-context": { session_id: "session-ctx" } }),
  ).toBe("session-ctx");
  expect(
    sessionIdOf({ "com.zcode/request-context": { root_session_id: "root-ctx" } }),
  ).toBe("root-ctx");
});

it("prefers the top-level id over the request-context copy", () => {
  expect(
    sessionIdOf({
      session_id: "flat",
      "com.zcode/request-context": { session_id: "nested" },
    }),
  ).toBe("flat");
  expect(
    sessionIdOf({
      root_session_id: "flat-root",
      session_id: "flat",
      "com.zcode/request-context": { root_session_id: "nested-root", session_id: "nested" },
    }),
  ).toBe("flat-root");
});

it("ignores empty, whitespace-only and non-string ids and keeps looking", () => {
  expect(
    sessionIdOf({
      session_id: "   ",
      "com.zcode/request-context": { session_id: "nested" },
    }),
  ).toBe("nested");
  expect(
    sessionIdOf({
      root_session_id: "",
      session_id: 42,
      "com.zcode/request-context": { root_session_id: null, session_id: "nested" },
    }),
  ).toBe("nested");
  expect(sessionIdOf({ session_id: {} })).toBeUndefined();
  expect(sessionIdOf({ "com.zcode/request-context": "not an object" })).toBeUndefined();
  expect(sessionIdOf(null)).toBeUndefined();
  expect(sessionIdOf(undefined)).toBeUndefined();
});

it("falls back to the default session key and keeps a bounded session count", () => {
  expect(DEFAULT_SESSION).toBe("default");
  expect(MAX_SESSIONS).toBe(32);
});
