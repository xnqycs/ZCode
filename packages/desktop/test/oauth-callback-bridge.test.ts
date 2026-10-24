import { describe, expect, it, vi } from "vitest";
import { createOAuthCallbackHandler } from "../src/preload/oauthCallbackBridge.js";

describe("oauth callback bridge", () => {
  it("forwards the callback url", async () => {
    const callback = vi.fn(async (_url: string) => {});
    const handler = createOAuthCallbackHandler(callback);

    await handler({}, "zcode://oauth/callback?code=123");

    expect(callback).toHaveBeenCalledWith("zcode://oauth/callback?code=123");
  });

  it("swallows callback rejection", async () => {
    const callback = vi.fn(async () => {
      throw new Error("callback failed");
    });
    const handler = createOAuthCallbackHandler(callback);

    await expect(handler({}, "zcode://oauth/callback?code=123")).resolves.toBeUndefined();
  });
});
