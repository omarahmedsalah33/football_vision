"""Prepare source-frame evidence and bounded, high-consequence Astra audit cases."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2


def prepare(root):
    manifest = json.loads((root / "manifest.json").read_text())
    data = json.loads((root / "video-proposals.json").read_text())
    (root / "evidence").mkdir(exist_ok=True)
    cap = cv2.VideoCapture(manifest["source_file"])
    if not cap.isOpened():
        raise ValueError("Cannot read original source")
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = {}

    def frame(seconds):
        number = max(0, min(round(seconds * fps), round(180 * fps)-1))
        frame_id = f"source-f{number:06d}"
        if frame_id in frames:
            return frames[frame_id]
        cap.set(cv2.CAP_PROP_POS_FRAMES, number)
        success, image = cap.read()
        if not success:
            raise ValueError("Could not read evidence frame")
        file = root / "evidence" / f"{frame_id}.jpg"
        if not cv2.imwrite(str(file), image, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise ValueError("Could not save source frame")
        record = {"id": frame_id, "file": str(file.relative_to(root)),
                  "source_time_s": number/fps, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
        frames[frame_id] = record
        return record

    primary = [e for e in data["events"] if e["in_primary_window"]]
    # Every primary proposal gets an actual original-source key frame.
    event_evidence = {e["id"]: frame(e["source_key_s"]) for e in primary}
    shots = sorted([e for e in primary if e["type"] == "shot"],
                   key=lambda e: (e["outcome"] != "goal", e["source_start_s"]))[:4]
    passes = sorted([e for e in primary if e["type"] == "pass" and e["source_start_s"] < 60],
                    key=lambda e: (0 if 40 <= e["source_start_s"] <= 50 else
                                   1 if 20 <= e["source_start_s"] <= 24 else 2, e["source_start_s"]))[:2]
    candidates = shots + passes
    # Use remaining audit slots for uncertain kicks; never expand the paid case budget.
    candidates += [e for e in primary if e["type"] == "unclear_kick"][:6-len(candidates)]
    cases = []
    for e in candidates:
        times = [max(0, e["source_start_s"]-.5), e["source_start_s"],
                 max(0, e["source_key_s"]-.4), e["source_key_s"],
                 min(179.99, e["source_key_s"]+.4), e["source_end_s"],
                 min(179.99, e["source_end_s"]+.5)]
        chosen = {f["id"]: f for f in map(frame, times)}
        cases.append({"id": e["id"], "claim": e,
                      "frames": sorted(chosen.values(), key=lambda f: f["source_time_s"])})
    cap.release()
    output = {"source_range_s": [0, 180], "catalog": manifest["catalog"],
              "anchors": manifest["anchors"], "cases": cases,
              "event_evidence": event_evidence,
              "reference_pdf_sha256": manifest["reference_pdf_sha256"],
              "audit_scope": "At most 6 selected claims: up to four shots/goals and two first-minute passes; spare slots may review unclear kicks. Not every action."}
    (root / "evidence-manifest.json").write_text(json.dumps(output, indent=2))
    print(f"Prepared {len(primary)} proposal evidence frames and {len(cases)} audit cases", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    prepare(parser.parse_args().input)
