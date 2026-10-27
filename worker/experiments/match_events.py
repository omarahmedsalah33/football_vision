"""Private, ephemeral Modal inference for a local video. Not the production job worker.

Usage from workspace root:
  PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/match_events.py \
    --video INPUT.mp4 --output generated-artifacts/match-events --probe

Footage is uploaded to a temporary Modal volume, never baked into an image or model cache.
No application database, production secret or public endpoint is involved.
"""
from __future__ import annotations

import argparse
import gzip
import json
import time
from pathlib import Path

import modal


def extract(video_volume, *, fps=10.0, probe=False, start=0.0, duration=None, detector="rfdetr"):
    """Runs inside Modal; return only metadata, writing detections to the ephemeral volume."""
    import os
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    from rfdetr import RFDETRSmall
    from rfdetr.assets.coco_classes import COCO_CLASSES
    from fa_worker.analysis.detector import nms
    from fa_worker.analysis.event_features import CameraMotion, kit_group

    if not torch.cuda.is_available():
        raise RuntimeError("GPU unavailable; refusing an unannounced slow CPU run")
    os.chdir("/models")
    torch.set_num_threads(4)
    person = next(k for k, v in COCO_CLASSES.items() if v == "person")
    ball = next(k for k, v in COCO_CLASSES.items() if v == "sports ball")
    if detector == "soccernet":
        import argparse
        import hashlib
        from huggingface_hub import hf_hub_download
        from rfdetr import RFDETRBase
        weights = hf_hub_download("julianzu9612/RFDETR-Soccernet", "weights/checkpoint_best_regular.pth",
                                 revision="1e388b922a64f2be39cbf1925e5fd5fc4f7dd771")
        digest = hashlib.sha256()
        with open(weights, "rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != "b9ade4bcc2316259582674ebeebbd27bb2e956480428c54114ace567237eb5f9":
            raise ValueError("SoccerNet checkpoint checksum mismatch")
        # Only a standard-library metadata container is allowed; never enable unrestricted pickle.
        with torch.serialization.safe_globals([argparse.Namespace]):
            checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
        # This checkpoint is the legacy Large architecture despite the author's Base loader.
        model = RFDETRBase(pretrain_weights=None, num_classes=4,
                          encoder="dinov2_windowed_base", hidden_dim=384, sa_nheads=12, ca_nheads=24,
                          dec_n_points=4, projector_scale=["P3", "P5"])
        model.model.model.reinitialize_detection_head(4)
        current = model.model.model.state_dict()
        if "_kp_active_mask" in current and "_kp_active_mask" not in checkpoint["model"]:
            # New non-parameter keypoint bookkeeping, unused by this detection-only checkpoint.
            checkpoint["model"]["_kp_active_mask"] = current["_kp_active_mask"]
        model.model.model.load_state_dict(checkpoint["model"], strict=True)
        person, ball = 1, 0
        del checkpoint
    else:
        model = RFDETRSmall()
    model.inference(compile=False, dtype=torch.float16)
    if detector == "footandball":
        from fa_worker.analysis.football_ball import load
        ball_model, to_tensor, ball_label = load()
    motion = CameraMotion()
    cap = cv2.VideoCapture("/input/video.mp4")
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not cap.isOpened() or not np.isfinite(source_fps) or source_fps <= 0:
        raise ValueError("Cannot decode a video with a valid source frame rate")
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) / source_fps
    end = min(total, start + duration) if duration else total
    if not np.isfinite(total) or not 0 <= start < end:
        raise ValueError("The requested interval is outside the source video")
    width, height = int(cap.get(3)), int(cap.get(4))
    probe_times = [10, 11, 12, 15, 30, 45, 60, 120, 300, 600, 900, 1500, 2100, 2700, 3000]
    times = [t for t in probe_times if t < total] if probe else np.arange(start, end, 1 / fps)
    count = ball_frames = 0
    begun = time.monotonic()
    # A full frame for people plus four overlapping crops for the small ball.
    tw, th = int(width * 0.6), int(height * 0.78)
    tiles = [(0, 0, width, height), (0, 0, tw, th), (width - tw, 0, width, th),
             (0, height - th, tw, height), (width - tw, height - th, width, height)]
    with gzip.open("/input/detections.jsonl.gz", "wt") as out:
        for t in times:
            frame_index = int(round(float(t) * source_fps))
            # Probe seeks are sparse; full runs decode sequentially rather than seeking per frame.
            if probe or count == 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            else:
                while int(round(cap.get(cv2.CAP_PROP_POS_FRAMES))) < frame_index:
                    if not cap.grab():
                        break
            ok, bgr = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            active_tiles = tiles if detector == "rfdetr" else tiles[:1]
            crops = [Image.fromarray(rgb[y0:y1, x0:x1]) for x0, y0, x1, y1 in active_tiles]
            with torch.inference_mode():
                detections = model.predict(crops, threshold=0.12)
            if not isinstance(detections, list):
                detections = [detections]
            people, balls = [], []
            for idx, (d, (x0, y0, _, _)) in enumerate(zip(detections, active_tiles)):
                xyxy = d.xyxy + np.array([x0, y0, x0, y0])
                for box, score, cls in zip(xyxy, d.confidence, d.class_id):
                    if idx == 0 and cls == person and score >= 0.35:
                        people.append([*box.tolist(), float(score)])
                    elif cls == ball and detector in ("rfdetr", "soccernet"):
                        balls.append([*box.tolist(), float(score)])
            if detector == "footandball":
                enlarged = cv2.resize(bgr, (width * 2, height * 2), interpolation=cv2.INTER_CUBIC)
                with torch.inference_mode():
                    detected = ball_model(to_tensor(enlarged).unsqueeze(0).cuda())[0]
                for box, score, label in zip(detected["boxes"], detected["scores"], detected["labels"]):
                    if int(label) == ball_label:
                        balls.append([*(box.detach().cpu().numpy() / 2).tolist(), float(score)])
            balls = nms(np.array(balls).reshape(-1, 5), iou=0.25).tolist()
            camera = motion.update(bgr, people)
            # A homography across sparse probe frames is not valid evidence of continuous tracking.
            if probe:
                camera = None
            record = {"t": frame_index / source_fps, "people": people, "balls": balls,
                      "kits": [kit_group(bgr, box) for box in people], "motion": camera}
            out.write(json.dumps(record, separators=(",", ":")) + "\n")
            count += 1
            ball_frames += bool(balls)
            if count % 100 == 0:
                print(f"frames={count} t={float(t):.1f}s ball_frames={ball_frames} elapsed={time.monotonic()-begun:.0f}s", flush=True)
    cap.release()
    meta = {
        "model": ("SoccerNet fine-tuned legacy RF-DETR Large (model card declares Apache-2.0; experimental)" if detector == "soccernet" else
                  "RF-DETR Small people (Apache-2.0) + " + ("FootAndBall football ball (MIT)" if detector == "footandball" else "COCO ball")),
        "detector_threshold": 0.12, "person_threshold": 0.35,
        "tiles": active_tiles, "ball_detector": detector, "video_duration_s": total, "width": width, "height": height,
        "source_fps": source_fps, "analysis_fps": fps, "probe": probe,
        "timestamp_method": "frame_index/source_fps; constant-frame-rate experiment",
        "start_s": start, "end_s": end, "frames": count, "ball_candidate_frames": ball_frames,
        "elapsed_s": time.monotonic() - begun,
    }
    from importlib.metadata import version
    meta["package_versions"] = {name: version(name) for name in ("torch", "rfdetr", "numpy", "opencv-python")}
    video_volume.commit()
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--fps", type=float, default=10)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--detector", choices=("rfdetr", "footandball", "soccernet"), default="rfdetr")
    parser.add_argument("--image-id", help="Reuse an already built experiment image; its worker source must match")
    args = parser.parse_args()
    if not args.video.is_file() or not 1 <= args.fps <= 30 or args.start < 0 or (args.duration is not None and args.duration <= 0):
        parser.error("Existing video, 1–30 fps, nonnegative start and positive duration required")
    from modal_app import gpu_image, model_cache
    if args.image_id:
        gpu_image = modal.Image.from_id(args.image_id).env({"PYTHONPATH": "/opt", "HF_HOME": "/models/huggingface", "TORCH_HOME": "/models/torch"})
    args.output.mkdir(parents=True, exist_ok=True)
    app = modal.App("football-vision-private-event-test")
    with modal.Volume.ephemeral() as inputs:
        print("Uploading test footage to temporary private Modal volume", flush=True)
        with inputs.batch_upload() as batch:
            batch.put_file(args.video, "/video.mp4")
        print("Upload complete; starting detector", flush=True)
        remote = app.function(
            image=gpu_image, gpu="L4", cpu=4, memory=16384, timeout=7200,
            max_containers=1, scaledown_window=2,
            volumes={"/input": inputs, "/models": model_cache},
        )(extract)
        with modal.enable_output(), app.run():
            meta = remote.remote(inputs, fps=args.fps, probe=args.probe, start=args.start, duration=args.duration, detector=args.detector)
            with (args.output / "detections.jsonl.gz").open("wb") as target:
                for chunk in inputs.read_file("detections.jsonl.gz"):
                    target.write(chunk)
            (args.output / "inference.json").write_text(json.dumps(meta, indent=2))
            print(json.dumps(meta, indent=2), flush=True)


if __name__ == "__main__":
    main()
