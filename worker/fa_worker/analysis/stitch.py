"""Joining track fragments that belong to the same player.

A tracker loses a player when they are hidden (behind another player, out of view for a moment) and
starts a new track when they reappear. Two fragments are joined when the second starts shortly after
the first ends, close enough to be reached at a running pace, in the same team. The joining is
deliberately conservative: when two fragments could each continue the same track about equally
well, neither is joined, because a wrong join mixes two players' numbers and is worse than a gap.
"""

from __future__ import annotations

import math

MAX_GAP_S = 6.0  # longer disappearances are not bridged
MAX_SPEED = 7.5  # m/s a player could have covered while hidden
SLACK_M = 2.5  # tracking noise at both ends
AMBIGUITY_M = 1.5  # a rival continuation within this many "metres" of cost makes the link unsafe


def stitch(tracks: dict[int, list[tuple[float, float, float]]], team_of: dict[int, str]) -> list[list[int]]:
    """tracks: {id: [(t, x, y), ...]} sorted by t. Returns chains of track ids, one per player."""
    ids = sorted(tracks, key=lambda k: tracks[k][0][0])
    candidates: list[tuple[float, int, int]] = []
    for a in ids:
        if team_of.get(a) not in ("a", "b"):
            continue  # officials and unassigned tracks stay as they are
        t_end, xa, ya = tracks[a][-1]
        for b in ids:
            if b == a or team_of.get(b) != team_of[a]:
                continue
            t0, xb, yb = tracks[b][0]
            gap = t0 - t_end
            if gap <= 0 or gap > MAX_GAP_S:
                continue
            d = math.hypot(xb - xa, yb - ya)
            if d > MAX_SPEED * gap + SLACK_M:
                continue
            candidates.append((d + 1.5 * gap, a, b))

    # A link is unsafe when either end has a rival of similar cost.
    best_out: dict[int, list[float]] = {}
    best_in: dict[int, list[float]] = {}
    for cost, a, b in candidates:
        best_out.setdefault(a, []).append(cost)
        best_in.setdefault(b, []).append(cost)

    def clear(costs: list[float], cost: float) -> bool:
        others = sorted(costs)
        others.remove(cost)
        return not others or others[0] - cost >= AMBIGUITY_M

    nxt: dict[int, int] = {}
    prv: dict[int, int] = {}
    for cost, a, b in sorted(candidates):
        if a in nxt or b in prv:
            continue
        if cost > min(best_out[a]) or cost > min(best_in[b]):
            continue  # not the best continuation on both sides
        if not (clear(best_out[a], cost) and clear(best_in[b], cost)):
            continue
        nxt[a], prv[b] = b, a

    chains = []
    for a in ids:
        if a in prv:
            continue
        chain = [a]
        while chain[-1] in nxt:
            chain.append(nxt[chain[-1]])
        chains.append(chain)
    return chains
