"""Compare geometry/coverage on frozen reference boxes; NOT a player accuracy score."""
import gzip
import json
import argparse
from collections import defaultdict
from pathlib import Path

from fa_worker.player_tracking import TrackingEvidence, overlap, unpack_tracks

ROOT = Path("generated-artifacts/tracking-comparison")
TARGET = Path("generated-artifacts/tracking-continuity-v2")


def audit(target=TARGET):
    roster = next(
        record["result"]["players"]
        for path in (ROOT/"baseline"/"checkpoints").glob("llm-*.json.gz")
        if "players" in (record := json.loads(gzip.decompress(path.read_bytes()))).get("result", {})
    )
    modes = {}
    for name,path in [("previous", ROOT/"player-tracks.json.gz"),
                      ("updated", target/"player-tracks.json.gz")]:
        tracker = TrackingEvidence(unpack_tracks(path.read_bytes()))
        catalog = []
        for player in roster:
            label = f"Unknown{len(catalog)+1}"
            bound = tracker.anchor([22,24][player["frame"]], player["box"], label)
            if not bound or bound == label:
                catalog.append(label)
        observed = defaultdict(list)
        bound_observations = total_observations = frames_with_anchor = 0
        for frame in tracker.data["frames"]:
            bound_here = False
            for person in frame["people"]:
                observed[person["id"]].append(frame["time"])
                total_observations += 1
                if person["id"] in tracker.bindings:
                    bound_observations += 1
                    bound_here = True
            frames_with_anchor += bound_here
        modes[name] = {"version":tracker.data["version"],"temporaryTracks":tracker.data["trackCount"],
            "continuityRegions":tracker.data["scenes"],"referenceLabels":len(catalog),
            "repeatedReferencesRemoved":tracker.duplicates,"anchoredTracks":len(tracker.bindings),
            "sampledFrames":len(tracker.data["frames"]),"personObservations":total_observations,
            "referenceBackedObservations":bound_observations,"framesWithReferenceBackedTrack":frames_with_anchor,
            "referenceBackedObservationFraction":round(bound_observations/max(1,total_observations),4),
            "longestObservedTrackSeconds":round(max(times[-1]-times[0] for times in observed.values()),1)}
        modes[name]["bindings"] = tracker.bindings
    report = {"scope":"Full 180 seconds, same frozen reference boxes at 22 and 24 seconds; no new AI calls",
              "caveat":"Temporary tracks, geometric reference coverage and fewer resets are diagnostics, not identity accuracy or final player statistics.",
              "modes":modes}
    target.mkdir(parents=True,exist_ok=True)
    (target/"continuity-audit.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--updated-dir",type=Path,default=TARGET)
    audit(parser.parse_args().updated_dir)
