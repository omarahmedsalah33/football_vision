"""Scores predicted pitch positions against ground truth.

Matching is done per frame in pitch space (Hungarian assignment, accept within `radius` metres),
the same principle as GS-HOTA's localisation step. Reported metrics:

- detection recall / precision: how many real people we found, and how many of our tracks are real;
- localisation error: metres between matched predictions and the truth;
- team accuracy: share of matched players put in the right team (our a/b mapped to the truth's
  left/right by majority);
- identity switches per minute: how often the predicted track following a real person changes;
- team-width error: our team width per window versus the width computed from the truth.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

import numpy as np

from ..analysis.metrics import frame_shape


@dataclass
class GtPerson:
    track_id: int
    role: str  # player | goalkeeper | referee | other
    side: str | None  # left | right
    x: float
    y: float


@dataclass
class PredPerson:
    track_no: int
    team: str  # a | b | other
    x: float
    y: float


def _assign(gt: np.ndarray, pred: np.ndarray, radius: float) -> list[tuple[int, int, float]]:
    if len(gt) == 0 or len(pred) == 0:
        return []
    from scipy.optimize import linear_sum_assignment

    cost = np.linalg.norm(gt[:, None, :] - pred[None, :, :], axis=2)
    rows, cols = linear_sum_assignment(np.where(cost <= radius, cost, 1e6))
    return [(int(r), int(c), float(cost[r, c])) for r, c in zip(rows, cols) if cost[r, c] <= radius]


def evaluate(
    gt_frames: dict[float, list[GtPerson]],
    pred_frames: dict[float, list[PredPerson]],
    radius: float = 2.0,
    length: float = 105.0,
    window_s: float = 10.0,
    pred_windows: list[dict] | None = None,
) -> dict:
    tp = fp = fn = 0
    loc: list[float] = []
    team_votes: Counter = Counter()  # (pred team, gt side) → count
    team_pairs: list[tuple[str, str]] = []
    followed: dict[int, list[tuple[float, int]]] = defaultdict(list)  # gt track → [(t, pred track)]
    gt_by_window: dict[int, list[np.ndarray]] = defaultdict(list)

    times = sorted(t for t in pred_frames if t in gt_frames)
    for t in times:
        gt = [g for g in gt_frames[t] if g.role != "other"]
        pred = pred_frames[t]
        matches = _assign(np.array([[g.x, g.y] for g in gt]).reshape(-1, 2), np.array([[p.x, p.y] for p in pred]).reshape(-1, 2), radius)
        tp += len(matches)
        fn += len(gt) - len(matches)
        fp += len(pred) - len(matches)
        for i, j, d in matches:
            loc.append(d)
            followed[gt[i].track_id].append((t, pred[j].track_no))
            if gt[i].side and pred[j].team in ("a", "b"):
                team_votes[(pred[j].team, gt[i].side)] += 1
                team_pairs.append((pred[j].team, gt[i].side))
        left = np.array([[g.x, g.y] for g in gt if g.side == "left"]).reshape(-1, 2)
        gt_by_window[int(t // window_s)].append(left)

    # Map our team labels to the truth's sides by majority vote.
    mapping = {}
    for team in ("a", "b"):
        votes = {side: team_votes[(team, side)] for side in ("left", "right")}
        if any(votes.values()):
            mapping[team] = max(votes, key=votes.get)
    team_acc = (sum(1 for p, g in team_pairs if mapping.get(p) == g) / len(team_pairs)) if team_pairs else None

    switches = 0
    for seq in followed.values():
        seq.sort()
        switches += sum(1 for k in range(1, len(seq)) if seq[k][1] != seq[k - 1][1])
    minutes = (times[-1] - times[0]) / 60 if len(times) > 1 else 0

    width_errors = []
    if pred_windows:
        team_for_left = next((k for k, v in mapping.items() if v == "left"), None)
        for w in pred_windows:
            k = int(w["start"] // window_s)
            ours = w.get(team_for_left) if team_for_left else None
            truth = [frame_shape(xy, True, length) for xy in gt_by_window.get(k, [])]
            truth = [s["width"] for s in truth if s]
            if ours and truth:
                width_errors.append(abs(ours["width"] - float(np.median(truth))))

    return {
        "framesScored": len(times),
        "matchRadiusM": radius,
        "detectionRecall": tp / (tp + fn) if tp + fn else None,
        "detectionPrecision": tp / (tp + fp) if tp + fp else None,
        "localisationErrorM": {"mean": float(np.mean(loc)) if loc else None, "p90": float(np.percentile(loc, 90)) if loc else None},
        "teamAccuracy": team_acc,
        "teamMapping": mapping,
        "idSwitchesPerMinute": switches / minutes if minutes else None,
        "gtPeopleFollowed": len(followed),
        "teamWidthErrorM": {"mean": float(np.mean(width_errors)) if width_errors else None, "windows": len(width_errors)},
    }
