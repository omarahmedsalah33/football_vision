import { initials, RATING_ORDER, type GameRatingsView } from "./game-ratings-view";

export type StatCardInput = {
  matchTitle: string; teamAName: string; teamBName: string;
  playerName: string; shirtNumber: number | null; teamName: string;
  counts: { goals: number; shots: number; passes: number; carries: number };
  awards: string[];
  /** Optional game-style ratings. When present the gold card layout is used. */
  ratings?: GameRatingsView | null;
  /** Already-decoded image (never a URL), so no link or token can end up in the PNG. */
  photo?: ImageBitmap | HTMLImageElement | null;
};

const SANS = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Arabic', sans-serif";

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = [...text];
  while (t.length > 1 && ctx.measureText(`${t.join("")}...`).width > max) t = t.slice(0, -1);
  return `${t.join("")}...`;
}

function shield(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h * 0.07); ctx.lineTo(x + w, y + h * 0.78);
  ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h * 0.78); ctx.lineTo(x, y + h * 0.07); ctx.closePath();
}

/** Loads an image from a private URL into memory. Returns null on CORS/network failure. */
export async function loadPhotoForCard(url: string | null | undefined): Promise<ImageBitmap | null> {
  if (!url || typeof createImageBitmap === "undefined") return null;
  try {
    const res = await fetch(url, { credentials: url.startsWith("/") ? "same-origin" : "omit", cache: "no-store" });
    if (!res.ok) return null;
    if (res.headers.get("content-type")?.includes("application/json")) {
      const data = await res.json() as { image?: string };
      if (!data.image?.startsWith("data:image/jpeg;base64,")) return null;
      return await createImageBitmap(await (await fetch(data.image)).blob());
    }
    return await createImageBitmap(await res.blob());
  } catch { return null; }
}

/** Draws a 1080x1350 card. Contains names, numbers and caveats only; never URLs or metadata. */
export async function renderStatCardPng(c: StatCardInput): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1080; canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is not supported in this browser.");
  ctx.fillStyle = "#0e1a14"; ctx.fillRect(0, 0, 1080, 1350);
  ctx.textBaseline = "alphabetic";

  if (c.ratings) {
    const r = c.ratings;
    ctx.fillStyle = "#c9e265"; ctx.font = `700 30px ${SANS}`; ctx.textAlign = "center";
    ctx.fillText("GAME-STYLE ESTIMATES · 7-A-SIDE", 540, 70);
    ctx.fillStyle = "#a9b5ab"; ctx.font = `400 28px ${SANS}`;
    ctx.fillText(fit(ctx, `${c.matchTitle} · ${c.teamAName} vs ${c.teamBName}`, 960), 540, 112);
    const X = 190, Y = 150, W = 700, H = 980;
    const g = ctx.createLinearGradient(X, Y, X + W, Y + H);
    g.addColorStop(0, "#f7e7a6"); g.addColorStop(0.38, "#e2bf5d"); g.addColorStop(0.62, "#c99a2e"); g.addColorStop(1, "#f0d68a");
    shield(ctx, X, Y, W, H); ctx.fillStyle = g; ctx.fill();
    shield(ctx, X + 16, Y + 16, W - 32, H - 32); ctx.strokeStyle = "rgba(90,62,8,.45)"; ctx.lineWidth = 4; ctx.stroke();
    const ink = "#3a2a06";
    ctx.textAlign = "left"; ctx.fillStyle = ink;
    ctx.font = `900 120px ${SANS}`; ctx.fillText(String(r.overall), X + 70, Y + 200);
    ctx.font = `700 30px ${SANS}`; ctx.fillText("OVR", X + 78, Y + 245);
    if (c.shirtNumber !== null) { ctx.font = `700 40px ${SANS}`; ctx.fillText(`#${c.shirtNumber}`, X + 78, Y + 310); }
    const cx = X + 470, cy = Y + 260, rad = 175;
    ctx.save(); ctx.beginPath(); ctx.roundRect(cx-rad,cy-rad,rad*2,rad*2,18); ctx.closePath();
    ctx.fillStyle = "#f3df9b"; ctx.fill(); ctx.clip();
    if (c.photo) {
      const pw = c.photo.width, ph = c.photo.height, s = Math.min((rad * 2) / pw, (rad * 2) / ph);
      ctx.drawImage(c.photo, cx - (pw * s) / 2, cy - (ph * s) / 2, pw * s, ph * s);
    } else {
      ctx.fillStyle = "#8a6516"; ctx.font = `800 120px ${SANS}`; ctx.textAlign = "center";
      ctx.fillText(initials(c.playerName), cx, cy + 42);
    }
    ctx.restore();
    ctx.textAlign = "center"; ctx.fillStyle = ink;
    ctx.font = `900 64px ${SANS}`; ctx.fillText(fit(ctx, c.playerName.toUpperCase(), W - 140), 540, Y + 530);
    ctx.font = `600 28px ${SANS}`; ctx.fillText(fit(ctx, c.teamName, W - 160), 540, Y + 572);
    ctx.fillRect(X + 90, Y + 595, W - 180, 3);
    const by = new Map(r.attributes.map(a => [a.key, a]));
    RATING_ORDER.forEach((k, i) => {
      const a = by.get(k), col = i % 2, row = Math.floor(i / 2);
      const x = X + 150 + col * 250, y = Y + 670 + row * 70;
      ctx.textAlign = "right"; ctx.globalAlpha = a?.baseline ? 0.5 : 1;
      ctx.font = `900 54px ${SANS}`; ctx.fillText(String(a?.score ?? 50), x + 80, y);
      ctx.globalAlpha = 1; ctx.textAlign = "left"; ctx.font = `700 36px ${SANS}`;
      ctx.fillText(`${k}${a?.baseline ? "*" : ""}`, x + 96, y);
    });
    ctx.textAlign = "center"; ctx.font = `700 22px ${SANS}`;
    ctx.fillText("FOOTBALL VISION", 540, Y + 900);
    ctx.fillStyle = "#f2f0e6"; ctx.font = `500 28px ${SANS}`;
    ctx.fillText(`Goals ${c.counts.goals} · Shots ${c.counts.shots} · Passes ${c.counts.passes} · Carries ${c.counts.carries}`, 540, 1190);
    ctx.fillStyle = "#a9b5ab"; ctx.font = `400 23px ${SANS}`;
    ctx.fillText("Game-style estimates from AI-recorded actions, not measured performance.", 540, 1240);
    ctx.fillText(`* baseline 50: not enough evidence.${c.photo === null ? " Photo omitted." : ""} Not an official game rating.`, 540, 1275);
    ctx.fillText("Made with Football Vision", 540, 1312);
    ctx.textAlign = "left";
  } else {
    ctx.strokeStyle = "#c9e265"; ctx.lineWidth = 4; ctx.strokeRect(40, 40, 1000, 1270);
    ctx.fillStyle = "#c9e265"; ctx.font = `700 34px ${SANS}`; ctx.fillText("7-A-SIDE · AI ESTIMATES", 80, 120);
    ctx.fillStyle = "#f2f0e6"; ctx.font = `700 40px ${SANS}`; ctx.fillText(fit(ctx, c.matchTitle, 920), 80, 190);
    ctx.fillStyle = "#a9b5ab"; ctx.font = `400 32px ${SANS}`; ctx.fillText(fit(ctx, `${c.teamAName} vs ${c.teamBName}`, 920), 80, 240);
    ctx.fillStyle = "#f2f0e6"; ctx.font = `800 96px ${SANS}`; ctx.fillText(fit(ctx, c.playerName, 920), 80, 420);
    ctx.fillStyle = "#c9e265"; ctx.font = `600 38px ${SANS}`;
    ctx.fillText(fit(ctx, `${c.shirtNumber !== null ? `#${c.shirtNumber} · ` : ""}${c.teamName}`, 920), 80, 480);
    const items: [string, number][] = [["Goals", c.counts.goals], ["Shots", c.counts.shots], ["Passes", c.counts.passes], ["Carries", c.counts.carries]];
    items.forEach(([label, n], i) => {
      const x = 80 + (i % 2) * 480, y = 540 + Math.floor(i / 2) * 270;
      ctx.fillStyle = "#18291f"; ctx.fillRect(x, y, 440, 230);
      ctx.fillStyle = "#f2f0e6"; ctx.font = `800 140px ${SANS}`; ctx.fillText(String(n), x + 30, y + 150);
      ctx.fillStyle = "#a9b5ab"; ctx.font = `500 34px ${SANS}`; ctx.fillText(label, x + 30, y + 205);
    });
    ctx.fillStyle = "#e8c35a"; ctx.font = `600 30px ${SANS}`;
    c.awards.slice(0, 3).forEach((a, i) => ctx.fillText(fit(ctx, a, 920), 80, 1130 + i * 40));
    ctx.fillStyle = "#a9b5ab"; ctx.font = `400 26px ${SANS}`;
    ctx.fillText("AI estimates of recorded actions; may contain errors.", 80, 1240);
    ctx.fillText("Made with Football Vision", 80, 1280);
  }
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("Could not create the image."))), "image/png"));
}

export async function shareOrDownloadPng(blob: Blob, filename: string, title: string): Promise<"shared" | "cancelled" | "downloaded"> {
  const file = new File([blob], filename, { type: "image/png" });
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return "shared"; }
    catch (e) { if ((e as Error).name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}
