import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPhotoForCard, shareOrDownloadPng } from "@/app/app/[org]/matches/[matchId]/stat-card-png";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("stat-card sharing outcomes", () => {
  const card = new Blob(["synthetic PNG test bytes"], { type: "image/png" });
  it("loads the authenticated same-origin photo proxy without relying on bucket CORS", async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal("createImageBitmap",vi.fn().mockResolvedValue(bitmap));
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({image:"data:image/jpeg;base64,eA=="}),
      {headers:{"content-type":"application/json"}})).mockResolvedValueOnce(new Response(new Blob(["x"])));
    vi.stubGlobal("fetch",fetchMock);
    expect(await loadPhotoForCard("/api/private-photo")).toBe(bitmap);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({credentials:"same-origin"});
  });
  it("does not announce success when native sharing is cancelled", async () => {
    vi.stubGlobal("navigator", { canShare: () => true,
      share: vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")) });
    expect(await shareOrDownloadPng(card, "player.png", "Test match")).toBe("cancelled");
  });
  it("reports a completed native share only after the share promise resolves", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { canShare: () => true, share });
    expect(await shareOrDownloadPng(card, "player.png", "Test match")).toBe("shared");
    const file = share.mock.calls[0][0].files[0] as File;
    expect(file.name).toBe("player.png");
    expect(file.type).toBe("image/png");
  });
  it("downloads the PNG when file sharing is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {});
    const a = { click: vi.fn(), href: "", download: "" };
    vi.stubGlobal("document", { createElement: () => a });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-card");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    expect(await shareOrDownloadPng(card, "محمد.png", "Test match")).toBe("downloaded");
    expect(a.download).toBe("محمد.png");
    expect(a.click).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:test-card");
  });
});
