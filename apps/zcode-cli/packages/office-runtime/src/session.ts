/** Session key used when an MCP request carries no session id (old hosts and direct clients). */
export const DEFAULT_SESSION = "default";

/** Viewer sessions kept in memory; the least recently used one is dropped beyond this. */
export const MAX_SESSIONS = 32;

const REQUEST_CONTEXT = "com.zcode/request-context";
const ROOT_SESSION_ID = "root_session_id";
const SESSION_ID = "session_id";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The session that owns an MCP tool call, from the `_meta` of the request.
 *
 * The host writes both flat keys and a `com.zcode/request-context` copy for every model and panel
 * call. `root_session_id` wins over `session_id` (the official plugins do the same); the flat copy
 * wins over the namespaced one. Missing, empty, whitespace-only or non-string ids are skipped and
 * the caller falls back to {@link DEFAULT_SESSION} — never an error, so older callers still work.
 */
export function sessionIdOf(meta: unknown): string | undefined {
  const flat = record(meta);
  const context = record(flat?.[REQUEST_CONTEXT]);
  for (const source of [flat, context])
    for (const key of [ROOT_SESSION_ID, SESSION_ID]) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  return undefined;
}
