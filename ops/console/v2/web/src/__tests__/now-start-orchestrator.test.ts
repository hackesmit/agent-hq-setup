// The Start orchestrator button's request (hq-4npjr.11): the browser asks for the role
// only; model, cwd and seed are the server's, so a page cannot pick them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { startOrchestrator } from "../now/http";

afterEach(() => vi.unstubAllGlobals());

describe("startOrchestrator", () => {
  it("posts role orchestrator to /api/session/new and nothing else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, sid: "s-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    await startOrchestrator();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session/new");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "interactive", role: "orchestrator" });
  });
});
