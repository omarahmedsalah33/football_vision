"""Conservative, uncalibrated football event proposals, NOT official match statistics.

Input: timestamped person/ball detections, kit appearance, inter-frame camera homographies.
Output: short-lived tracklets, observable control, pass/carry/goalward movement candidates.
No jersey identity, metres, pass intent, goal or dribble success is invented.
"""
from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field
import math

import numpy as np
from scipy.optimize import linear_sum_assignment


def project(points, h):
    p = np.column_stack([np.asarray(points).reshape(-1, 2), np.ones(len(points))]) @ np.asarray(h).T
    if np.any(np.abs(p[:, 2]) < 1e-6):
        raise ValueError("Degenerate camera transformation")
    return p[:, :2] / p[:, 2:3]


def foot(box):
    return np.array([(box[0] + box[2]) / 2, box[3]])


@dataclass
class Track:
    id: int
    box: np.ndarray
    start: float
    last: float
    hits: int = 1
    kits: Counter = field(default_factory=Counter)
    visible_s: float = 0.0
    controlled_samples: int = 0

    @property
    def kit(self):
        if not self.kits:
            return "unknown"
        label, votes = self.kits.most_common(1)[0]
        return label if votes >= 2 and votes / sum(self.kits.values()) >= 0.8 else "unknown"

    @property
    def height(self):
        return max(6.0, float(self.box[3] - self.box[1]))


class EventAnalyzer:
    def __init__(self, width, height, *, goal_boxes=()):
        self.width, self.height = width, height
        self.tracks = {}
        self.archive = {}
        self.next_id = 1
        self.events = []
        self.samples = Counter()
        self.last_t = None
        self.ball = None
        self.ball_velocity = np.zeros(2)
        self.ball_streak = 0
        self.ball_last_t = None
        self.owner = None
        self.owner_since = None
        self.control = None
        self.visibility = deque()
        self.carry_distance = self.carry_since = 0.0
        self.last_carry_foot = None
        self.goals = [np.array([[x1, y1], [x2, y2]], dtype=float) for x1, y1, x2, y2 in goal_boxes]
        self.shot_release = None

    def _reset(self):
        self.tracks.clear()
        self.ball = self.control = self.owner = self.owner_since = None
        self.ball_streak = 0
        self.ball_velocity = np.zeros(2)
        self.ball_last_t = None
        self.carry_distance = 0
        self.last_carry_foot = None
        self.shot_release = None
        self.visibility.clear()

    def _players(self, boxes, kits, t, h):
        for track in self.tracks.values():
            corners = project([[track.box[0], track.box[1]], [track.box[2], track.box[3]]], h)
            track.box = corners.reshape(-1)
        self.tracks = {i: tr for i, tr in self.tracks.items() if t - tr.last <= 0.4}
        old = list(self.tracks.values())
        cost = np.full((len(old), len(boxes)), 1e6)
        for i, tr in enumerate(old):
            for j, box in enumerate(boxes):
                scale = max(6, box[3] - box[1], tr.height)
                distance = np.linalg.norm(foot(tr.box) - foot(box)) / scale
                ratio = abs(math.log(max(2, box[3] - box[1]) / tr.height))
                kit_penalty = 2 if tr.kit != "unknown" and kits[j] != "unknown" and tr.kit != kits[j] else 0
                if distance < 0.9 and ratio < 0.7:
                    cost[i, j] = distance + ratio * 0.3 + kit_penalty
        assigned = {}
        if old and len(boxes):
            rows, cols = linear_sum_assignment(cost)
            for i, j in zip(rows, cols):
                alternatives = np.delete(cost[:, j], i)
                # Reject crowded ambiguous assignments rather than joining different players.
                if cost[i, j] < 0.9 and (not len(alternatives) or min(alternatives) - cost[i, j] > 0.12):
                    tr = old[i]
                    tr.visible_s += t - tr.last
                    tr.box, tr.last, tr.hits = boxes[j], t, tr.hits + 1
                    assigned[j] = tr
        visible = []
        for j, box in enumerate(boxes):
            tr = assigned.get(j)
            if tr is None:
                tr = Track(self.next_id, box, t, t)
                self.next_id += 1
                self.tracks[tr.id] = self.archive[tr.id] = tr
            if kits[j] != "unknown":
                tr.kits[kits[j]] += 1
            visible.append(tr)
        return visible

    def _ball(self, boxes, t, h):
        candidates = []
        for box in boxes:
            x1, y1, x2, y2, score = box[:5]
            if score >= 0.22 and 1 <= x2 - x1 <= self.width * 0.05 and 1 <= y2 - y1 <= self.height * 0.09:
                p = np.array([(x1 + x2) / 2, (y1 + y2) / 2])
                if self.height * 0.30 < p[1] < self.height * 0.96:
                    candidates.append((p, float(score)))
        if self.ball_last_t is not None and t - self.ball_last_t > 0.3:
            self.ball = None
            self.ball_streak = 0
        warped = project([self.ball], h)[0] if self.ball is not None else None
        dt = t - self.ball_last_t if warped is not None else 0
        ranked = []
        for p, score in candidates:
            distance = np.linalg.norm(p - (warped + self.ball_velocity * dt)) if warped is not None else 0
            gate = 8 + 250 * dt
            if warped is None or distance < gate:
                ranked.append((score - distance / max(gate, 1) * 0.5, p, score))
        ranked.sort(key=lambda x: x[0], reverse=True)
        if not ranked or (len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.05):
            if warped is not None:
                self.ball = warped
            return None
        _, p, score = ranked[0]
        if warped is not None and dt > 0:
            self.ball_velocity = 0.5 * self.ball_velocity + 0.5 * (p - warped) / dt
        else:
            self.ball_velocity = np.zeros(2)
        self.ball, self.ball_last_t = p, t
        self.ball_streak += 1
        return (p, score) if self.ball_streak >= 3 else None

    def _emit(self, kind, start, end, **kwargs):
        event = {
            "id": f"event-{len(self.events) + 1:05d}", "type": kind,
            "start_s": round(float(start), 3), "end_s": round(float(end), 3),
            "review_status": "pending", "confidence": "unvalidated_heuristic",
            **kwargs,
        }
        self.events.append(event)

    def observe(self, record):
        t = float(record["t"])
        if not math.isfinite(t) or (self.last_t is not None and t <= self.last_t):
            raise ValueError("Frame timestamps must be finite and strictly increasing")
        dt = t - self.last_t if self.last_t is not None else 0
        h = record.get("motion")
        if self.last_t is not None and (dt > 0.5 or h is None):
            self._reset()
            self.goals = []  # Do not propagate manually marked goals through an unknown camera cut.
            self.samples["tracking_discontinuities"] += 1
        h = np.asarray(h if h is not None else np.eye(3), dtype=float)
        if h.shape != (3, 3) or not np.all(np.isfinite(h)):
            raise ValueError("Invalid camera homography")
        if self.control is not None:
            self.control["foot"] = project([self.control["foot"]], h)[0]
        if self.last_carry_foot is not None:
            self.last_carry_foot = project([self.last_carry_foot], h)[0]
        self.goals = [project(g, h) for g in self.goals]
        boxes = np.asarray(record.get("people", []), dtype=float).reshape(-1, 5)
        if len(boxes) and (not np.all(np.isfinite(boxes)) or np.any(boxes[:, 2:4] <= boxes[:, :2])):
            raise ValueError("Invalid person boxes")
        kits = record.get("kits", ["unknown"] * len(boxes))
        if len(kits) != len(boxes):
            raise ValueError("Kit labels must align with person detections")
        players = self._players(boxes, kits, t, h)
        ball = self._ball(record.get("balls", []), t, h)
        self.samples["frames"] += 1
        self.samples["raw_ball_candidate_frames"] += bool(record.get("balls"))
        self.samples["coherent_ball_frames"] += ball is not None
        self.visibility.append((t, ball is not None))
        while self.visibility and t - self.visibility[0][0] > 4:
            self.visibility.popleft()
        owner = None
        if ball:
            p, score = ball
            nearby = sorted(
                ((np.linalg.norm(foot(tr.box) - p) / max(6, tr.height * 0.35), tr) for tr in players if tr.hits >= 3),
                key=lambda v: v[0],
            )
            if nearby and nearby[0][0] < 1 and (len(nearby) == 1 or nearby[1][0] - nearby[0][0] >= 0.3):
                owner = nearby[0][1]
        if owner is None or owner.id != self.owner:
            self.owner = owner.id if owner else None
            self.owner_since = t
        stable = owner is not None and t - self.owner_since >= 0.19
        if stable:
            owner.controlled_samples += 1
            self.samples["controlled_ball_frames"] += 1
            previous = self.control
            if previous and previous["id"] != owner.id:
                gap = self.owner_since - previous["t"]
                history = [visible for stamp, visible in self.visibility if previous["t"] <= stamp <= t]
                coverage = sum(history) / len(history) if history else 0
                separation = np.linalg.norm(foot(owner.box) - previous["foot"]) / owner.height
                if 0.09 <= gap <= 3 and coverage >= 0.75 and separation >= 0.8:
                    same_kit = previous["kit"] == owner.kit and owner.kit in ("blue", "light")
                    self._emit("completed_pass_candidate" if same_kit else "control_transfer_candidate",
                               previous["t"], self.owner_since,
                               from_tracklet=previous["id"], to_tracklet=owner.id,
                               kit_group=owner.kit if same_kit else "unknown",
                               visible_ball_fraction=round(coverage, 3),
                               reason="Coherent ball travel between two sustained control estimates; intent and identity require review.")
                self.carry_distance = 0
                self.carry_since = t
                self.last_carry_foot = None
            elif previous and previous["id"] == owner.id and t - previous["t"] <= 0.2:
                if self.last_carry_foot is not None:
                    self.carry_distance += np.linalg.norm(foot(owner.box) - self.last_carry_foot) / owner.height
                if t - self.carry_since >= 2 and self.carry_distance >= 1.8:
                    self._emit("carry_candidate", self.carry_since, t, tracklet=owner.id, kit_group=owner.kit,
                               reason="Sustained estimated control with camera-compensated movement; not proof of beating an opponent.")
                    self.carry_since, self.carry_distance = t, 0
            else:
                self.carry_since, self.carry_distance = t, 0
            self.last_carry_foot = foot(owner.box)
            self.control = {"id": owner.id, "t": t, "kit": owner.kit, "foot": foot(owner.box)}
        elif self.control and t - self.control["t"] > 3:
            self.control = None
        # Optional manually anchored goal regions: propose goalward movement, never a goal/on-target result.
        if ball and not stable and self.control and t - self.control["t"] <= 1:
            p = ball[0]
            for goal in self.goals:
                center = goal.mean(axis=0)
                delta = center - p
                speed = float(np.linalg.norm(self.ball_velocity))
                alignment = np.dot(delta, self.ball_velocity) / max(np.linalg.norm(delta) * speed, 1e-6)
                release = (self.control["id"], self.control["t"])
                if speed > 20 and alignment > 0.97 and np.linalg.norm(delta) / speed <= 1.5 and release != self.shot_release:
                    self._emit("goalward_movement_candidate", self.control["t"], t,
                               tracklet=self.control["id"], reason="Ball trajectory points toward a manually marked goal; may be a pass or clearance, not a confirmed shot.")
                    self.shot_release = release
        self.last_t = t
        return {"t": t, "ball": ball[0].tolist() if ball else None,
                "owner": owner.id if stable else None,
                "players": [{"id": tr.id, "box": tr.box[:4].tolist(), "kit": tr.kit} for tr in players]}

    def report(self):
        n = self.samples["frames"]
        counts = Counter(event["type"] for event in self.events)
        passed = Counter(e["from_tracklet"] for e in self.events if e["type"] == "completed_pass_candidate")
        received = Counter(e["to_tracklet"] for e in self.events if e["type"] == "completed_pass_candidate")
        carried = Counter(e["tracklet"] for e in self.events if e["type"] == "carry_candidate")
        return {
            "status": "experimental_requires_review",
            "statistics": {key: None for key in (
                "passes_attempted", "passes_completed", "pass_accuracy_pct", "shots", "shots_on_target",
                "shot_accuracy_pct", "goals", "successful_dribbles", "dribble_success_pct",
                "possession_pct", "distance_m", "average_speed_kmh", "top_speed_kmh")},
            "candidate_counts": dict(counts),
            "coverage": {**dict(self.samples),
                         "coherent_ball_fraction": self.samples["coherent_ball_frames"] / n if n else 0,
                         "controlled_ball_fraction": self.samples["controlled_ball_frames"] / n if n else 0},
            "tracklets": [{"id": tr.id, "start_s": round(tr.start, 3), "last_s": round(tr.last, 3),
                          "observations": tr.hits, "visible_s": round(tr.visible_s, 3),
                          "kit_group": tr.kit, "controlled_samples": tr.controlled_samples,
                          "pass_candidates_made": passed[tr.id], "pass_candidates_received": received[tr.id],
                          "carry_candidates": carried[tr.id],
                          "identity": "unverified_tracklet_not_a_unique_player"}
                         for tr in self.archive.values() if tr.hits >= 3],
            "events": self.events,
            "limitations": [
                "Candidate counts are not confirmed match statistics; no accuracy evaluation against labelled footage has been performed.",
                "Kit appearance is not a verified team assignment; goalkeeper, referee and occluded-player assignments can be unknown.",
                "Tracklet IDs can restart after occlusion/camera movement and must not be treated as unique named players.",
                "Ball proximity is only an estimated control signal. A transfer does not establish a pass attempt or its intent.",
                "No metric pitch calibration or verified real-world pitch dimensions: metres and km/h unavailable.",
                "No validated shot-outcome, goal or opponent-beaten classifier: those statistics remain unavailable.",
                "Possession during missing/ambiguous ball observations is unknown; observed control is not whole-match possession.",
            ],
        }
