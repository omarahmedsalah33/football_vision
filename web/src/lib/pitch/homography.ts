/**
 * Planar homography between video pixels and pitch metres, fitted with the normalised Direct Linear
 * Transform (Hartley normalisation + smallest eigenvector of AᵀA). Pure functions, shared by the
 * browser (live feedback while calibrating) and the server (authoritative fit that is stored).
 */
export type Vec2 = [number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Correspondence = { image: Vec2; pitch: Vec2 };

export class CalibrationError extends Error {}

export function apply(H: Mat3, [x, y]: Vec2): Vec2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function mul(A: Mat3, B: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return r;
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new CalibrationError("The calibration is degenerate.");
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Similarity transform moving points to centroid 0 and mean distance √2 (Hartley). */
function normaliser(pts: Vec2[]): Mat3 {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const mean = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  if (mean < 1e-9) throw new CalibrationError("The points are all in the same place.");
  const k = Math.SQRT2 / mean;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Returns the eigenvector of the smallest eigenvalue. */
function smallestEigenvector(S: number[][]): number[] {
  const n = S.length;
  const a = S.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let min = 0;
  for (let i = 1; i < n; i++) if (a[i][i] < a[min][min]) min = i;
  return v.map((row) => row[min]);
}

/** Twice the signed area of a triangle; used to reject (near-)collinear point sets. */
function area2(a: Vec2, b: Vec2, c: Vec2) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function assertSpread(pitch: Vec2[]) {
  // At least one triangle of landmarks must cover a meaningful area of the pitch (> 20 m²).
  let best = 0;
  for (let i = 0; i < pitch.length; i++)
    for (let j = i + 1; j < pitch.length; j++)
      for (let k = j + 1; k < pitch.length; k++) best = Math.max(best, Math.abs(area2(pitch[i], pitch[j], pitch[k])) / 2);
  if (best < 20) throw new CalibrationError("The landmarks lie (almost) on one line. Add points that are spread across the pitch.");
}

/** Fits the homography mapping image pixels → pitch metres. Needs ≥ 4 well-spread correspondences. */
export function fitHomography(points: Correspondence[]): Mat3 {
  if (points.length < 4) throw new CalibrationError("At least 4 landmarks are needed.");
  assertSpread(points.map((p) => p.pitch));
  const Ti = normaliser(points.map((p) => p.image));
  const Tp = normaliser(points.map((p) => p.pitch));
  const rows: number[][] = [];
  for (const { image, pitch } of points) {
    const [x, y] = apply(Ti, image);
    const [u, v] = apply(Tp, pitch);
    rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    rows.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  const AtA = Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const h = smallestEigenvector(AtA) as Mat3;
  const H = mul(invert(Tp), mul(h, Ti));
  const scale = Math.abs(H[8]) > 1e-12 ? H[8] : 1;
  const out = H.map((x) => x / scale) as Mat3;
  invert(out); // throws if degenerate
  if (!out.every(Number.isFinite)) throw new CalibrationError("The calibration is degenerate.");
  return out;
}

/** Root-mean-square distance in metres between each landmark and where H maps its clicked pixel. */
export function rmsError(H: Mat3, points: Correspondence[]): number {
  const sq = points.map((p) => {
    const q = apply(H, p.image);
    return (q[0] - p.pitch[0]) ** 2 + (q[1] - p.pitch[1]) ** 2;
  });
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / points.length);
}

/** Per-point residuals in metres. */
export function residuals(H: Mat3, points: Correspondence[]): number[] {
  return points.map((p) => {
    const q = apply(H, p.image);
    return Math.hypot(q[0] - p.pitch[0], q[1] - p.pitch[1]);
  });
}

/**
 * Leave-one-out error: each landmark is predicted from a fit on the others. Unlike the fit error,
 * this can't be made small by over-fitting, so it is the honest accuracy estimate. Needs ≥ 5 points.
 */
export function leaveOneOutError(points: Correspondence[]): number | null {
  if (points.length < 5) return null;
  const sq: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const rest = points.filter((_, j) => j !== i);
    try {
      const H = fitHomography(rest);
      const q = apply(H, points[i].image);
      sq.push((q[0] - points[i].pitch[0]) ** 2 + (q[1] - points[i].pitch[1]) ** 2);
    } catch {
      return null; // the remaining points are degenerate on their own
    }
  }
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / sq.length);
}

/**
 * Rejects fits that can't come from a real camera: every point of the pitch must be in front of
 * the camera, so the projective scale w of the image→pitch inverse must have one sign over the whole
 * pitch rectangle. A misplaced click with only 4–5 points can otherwise fold the pitch through the
 * horizon and still fit "exactly".
 */
export function assertPlausible(H: Mat3, size: { length: number; width: number }) {
  const inv = invert(H); // pitch → image
  const corners: Vec2[] = [
    [0, 0],
    [size.length, 0],
    [size.length, size.width],
    [0, size.width],
  ];
  const ws = corners.map(([x, y]) => inv[6] * x + inv[7] * y + inv[8]);
  if (!(ws.every((w) => w > 1e-9) || ws.every((w) => w < -1e-9))) {
    throw new CalibrationError("These points would put part of the pitch behind the camera, so at least one is in the wrong place.");
  }
  // The pitch must also keep its orientation (no mirror image): left stays left of right as seen
  // from the camera, and the far touchline stays above the near one.
  const img = corners.map((c) => apply(inv, c));
  let signed = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = img[i];
    const [x2, y2] = img[(i + 1) % 4];
    signed += x1 * y2 - x2 * y1;
  }
  if (signed <= 0) {
    throw new CalibrationError("The points describe a mirrored pitch: check that left and right, and near and far, aren't swapped.");
  }
}
