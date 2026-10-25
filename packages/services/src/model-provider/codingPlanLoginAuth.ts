/** Login-token auth headers for BigModel/Z.ai business APIs (not model API keys). */
export function createBigModelLoginAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
  };
}

export function createZaiLoginAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
  };
}
