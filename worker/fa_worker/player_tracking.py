"""Scene-local player trajectories; no appearance embeddings or biometric recognition.

RF-DETR detects people (including officials/spectators). Only tracks anchored to the
pitch-only Gemini reference catalog may contribute to individual statistics.
"""
from __future__ import annotations

import gzip
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np

from .errors import JobFailure

TRACKING_VERSION = "rfdetr-bytetrack-v3"
SAMPLE_FPS = 10


def shirt_category(image, box):
    """Strong KIT-colour conflict only; never use colour to join two track IDs."""
    import cv2
    h, w = image.shape[:2]
    x1,y1,x2,y2 = np.asarray(box[:4],dtype=float)
    left = max(0,int(x1+.25*(x2-x1)))
    right = min(w,int(x1+.75*(x2-x1)))
    top = max(0,int(y1+.22*(y2-y1)))
    bottom = min(h,int(y1+.48*(y2-y1)))
    if right-left < 3 or bottom-top < 3:
        return None
    pixels = cv2.cvtColor(image[top:bottom,left:right],cv2.COLOR_RGB2HSV).reshape(-1,3)
    if len(pixels) < 60:
        return None
    hue, sat, value = (pixels[:,i] for i in range(3))
    light = np.mean((sat < 65) & (value > 105))
    blue = np.mean((hue >= 90) & (hue <= 135) & (sat > 55) & (value > 45))
    if blue >= .6 and blue > light*1.5:
        return "blue"
    if light >= .55 and light > blue*1.5:
        return "light"
    return None


def transform_boxes(boxes, matrix):
    """Move axis-aligned boxes through a scene's camera transform, preserving scores."""
    if not len(boxes):
        return boxes.copy()
    corners = boxes[:, [0, 1, 2, 1, 2, 3, 0, 3]].reshape(-1, 4, 2)
    mapped = corners @ matrix[:2, :2].T + matrix[:2, 2]
    result = boxes.copy()
    result[:, :4] = np.column_stack((mapped[:, :, 0].min(1), mapped[:, :, 1].min(1),
                                     mapped[:, :, 0].max(1), mapped[:, :, 1].max(1)))
    return result


def camera_step(previous, current, width, height):
    """Robust frame geometry only; no player appearance/face embeddings."""
    import cv2
    def fit(before, after):
        if len(before) < 12:
            return None
        affine, inliers = cv2.estimateAffinePartial2D(before, after, method=cv2.RANSAC, ransacReprojThreshold=2)
        if affine is None or inliers is None or inliers.mean() < .55:
            return None
        if not .85 <= float(np.hypot(affine[0, 0], affine[1, 0])) <= 1.15:
            return None
        # Correspondence consensus must also explain the image, not just a few
        # similarly moving players or an overlay. This is scene geometry only.
        warped = cv2.warpAffine(previous, affine, (current.shape[1],current.shape[0]))
        valid = cv2.warpAffine(np.ones_like(previous), affine, (current.shape[1],current.shape[0])) > 0
        if valid.mean() < .5 or np.median(np.abs(warped.astype(float)-current)[valid]) > 18:
            return None
        return affine
    affine = None
    points = cv2.goodFeaturesToTrack(previous, maxCorners=250, qualityLevel=.01, minDistance=5)
    if points is not None and len(points) >= 12:
        moved, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None)
        if moved is not None and status is not None:
            keep = status.ravel() == 1
            affine = fit(points[keep], moved[keep])
    if affine is None:
        # Wider camera pans can defeat local optical flow. ORB compares scene
        # corners, not player appearance, faces, body shape or gait.
        orb = cv2.ORB_create(nfeatures=1200, edgeThreshold=12, fastThreshold=10)
        a, ad = orb.detectAndCompute(previous, None)
        b, bd = orb.detectAndCompute(current, None)
        if ad is not None and bd is not None and len(bd) >= 2:
            pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(ad, bd, k=2)
            good = [p[0] for p in pairs if len(p)==2 and p[0].distance < .7*p[1].distance]
            # A target corner cannot count as multiple independent observations.
            good = list({p.trainIdx:p for p in sorted(good,key=lambda p:p.distance,reverse=True)}.values())
            if len(good) >= 12:
                affine = fit(np.float32([a[p.queryIdx].pt for p in good]),
                             np.float32([b[p.trainIdx].pt for p in good]))
    if affine is None:
        return None
    matrix = np.eye(3)
    matrix[:2] = affine
    resize = np.diag([width/previous.shape[1], height/previous.shape[0], 1.])
    return resize @ matrix @ np.linalg.inv(resize)


def collect_tracks(source, progress=lambda: None, detector=None, tracker_factory=None):
    import av
    import cv2
    from .analysis.detector import RFDETRDetector
    from .analysis.tracker import ByteTrackTracker

    # Low-score detections can recover an existing track in ByteTrack's second
    # association stage. New tracks still require the independent .5 threshold.
    detector = detector or RFDETRDetector(size="nano", threshold=.2, tile=960)
    tracker_factory = tracker_factory or (lambda: ByteTrackTracker(SAMPLE_FPS, lost_seconds=2, min_frames=2))
    tracker = tracker_factory()
    frames, lengths = [], Counter()
    previous, last, geometry = None, -math.inf, None
    camera = np.eye(3)
    scene, serial, ids, colors = 1, 0, {}, {}
    with av.open(str(source)) as container:
        stream = container.streams.video[0]
        origin = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0
        for decoded in container.decode(stream):
            if decoded.pts is None:
                continue
            t = float(decoded.pts * stream.time_base) - origin
            if t < 0 or t + .0001 < last + 1 / SAMPLE_FPS:
                continue
            image = decoded.to_ndarray(format="rgb24")
            thumb = cv2.resize(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), (64, 36)).astype(float)
            small = cv2.resize(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), (320, 180))
            # Hard cuts get new IDs. No cross-cut stitching or kit-only auto-merging.
            step = camera_step(geometry, small, image.shape[1], image.shape[0]) if geometry is not None else None
            cut = previous is not None and (t-last > .6 or
                  (step is None and np.abs(thumb-previous).mean() > 35))
            if cut:
                scene += 1
                tracker, ids, colors = tracker_factory(), {}, {}
                camera = np.eye(3)
            elif geometry is not None:
                if step is not None:
                    camera = step @ camera
                elif np.abs(thumb-previous).mean() > 12:
                    # A camera jump we cannot place is not evidence of player continuity.
                    scene += 1
                    tracker, ids, colors, camera = tracker_factory(), {}, {}, np.eye(3)
            previous, last = thumb, t
            geometry = small
            stable = transform_boxes(detector.detect(image, t), np.linalg.inv(camera))
            boxes, local_ids = tracker.update(stable)
            boxes = transform_boxes(boxes, camera)
            h, w = image.shape[:2]
            people = []
            for box, local_id in zip(boxes, local_ids):
                if int(local_id) not in ids:
                    serial += 1
                    ids[int(local_id)] = f"T{serial}"
                tid = ids[int(local_id)]
                color = shirt_category(image, box)
                if color and tid in colors and colors[tid] != color:
                    # An IoU/Kalman match crossed between visibly different kits.
                    # Sever the ID; NEVER reconnect it on a later matching colour.
                    serial += 1
                    tid = ids[int(local_id)] = f"T{serial}"
                if color:
                    colors[tid] = color
                normalized = np.asarray(box) * np.array([1000/w, 1000/h, 1000/w, 1000/h])
                people.append({"id": tid, "box": [round(float(x), 1) for x in normalized]})
                lengths[tid] += 1
            frames.append({"time": round(t, 3), "scene": scene, "people": people})
            if len(frames) % 25 == 0:
                progress()
    if not frames or not lengths:
        raise JobFailure("tracking_no_players", "The tracker could not establish player tracks. Try Gemini–Astra mode.")
    return {"version": TRACKING_VERSION, "sampleFps": SAMPLE_FPS, "detector": detector.version,
            "tracker": tracker.version, "scenes": scene, "frames": frames,
            "trackCount": len(lengths), "sampleCount": len(frames), "cameraCompensated": True}


def pack_tracks(data):
    return gzip.compress(json.dumps(data, allow_nan=False, separators=(",", ":")).encode())


def unpack_tracks(payload):
    with gzip.GzipFile(fileobj=__import__("io").BytesIO(payload)) as source:
        raw = source.read(128 * 1024 * 1024 + 1)
    if len(raw) > 128 * 1024 * 1024:
        raise JobFailure("tracking_limit", "Player tracking exceeded the safe result size.")
    data = json.loads(raw)
    # Historical trajectories remain readable for controlled comparisons. New
    # checkpoint bindings include TRACKING_VERSION, so jobs cannot mix algorithms.
    if data.get("version") not in {"rfdetr-bytetrack-v1", "rfdetr-bytetrack-v2", TRACKING_VERSION} or not data.get("frames"):
        raise JobFailure("tracking_invalid", "The player tracking result was invalid.")
    return data


def overlap(a, b):
    inter = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return inter / max(1e-9, (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter)


class TrackingEvidence:
    """Only exact, unambiguous reference-box anchors propagate a catalog identity."""

    def __init__(self, data):
        from bisect import bisect_left
        self.data, self.bindings, self.anchor_boxes = data, {}, {}
        self.times = [f["time"] for f in data["frames"]]
        self._search = bisect_left
        self.duplicates = 0

    def at(self, seconds):
        i = self._search(self.times, seconds)
        indices = [n for n in (i-1, i) if 0 <= n < len(self.times)]
        if not indices:
            return None
        nearest = min(indices, key=lambda n: abs(self.times[n]-seconds))
        return self.data["frames"][nearest] if abs(self.times[nearest]-seconds) <= .25 else None

    def anchor(self, seconds, box, player_id):
        frame = self.at(seconds)
        if not frame:
            return None
        ranked = sorted(((overlap(box, p["box"]), p["id"]) for p in frame["people"]), reverse=True)
        if not ranked or ranked[0][0] < .55 or (len(ranked) > 1 and ranked[0][0]-ranked[1][0] < .2):
            return None
        tid = ranked[0][1]
        if tid in self.bindings:
            # A same-track match is NOT sufficient to merge simultaneous overlapping
            # roster boxes. Only duplicates from different reference times may merge.
            old_time, old_box = self.anchor_boxes[tid]
            if abs(seconds-old_time) < .5:
                return None
            self.duplicates += 1
            return self.bindings[tid]
        self.bindings[tid] = player_id
        self.anchor_boxes[tid] = (seconds, box)
        return player_id

    def reconcile(self, event):
        tid = event.get("actorTrackId")
        frame = self.at(event["key"])
        visible = frame and any(p["id"] == tid for p in frame["people"])
        bound = self.bindings.get(tid) if isinstance(tid, str) else None
        actor = event.get("actorId")
        status = "supported" if visible and bound and actor == bound else (
            "conflict" if visible and bound and actor and actor != bound else
            "unanchored" if visible else "not_visible")
        event["tracking"] = {"trackId": tid if isinstance(tid, str) else None,
                             "status": status, "suggestedActorId": bound if visible else None}
        if status != "supported":
            event["geminiActorId"] = actor
            event["actorId"], event["identityConfidence"] = None, "unassigned"
        return event

    def summary(self, events):
        return {"enabled": True, "method": self.data["version"], "sampleFps": self.data["sampleFps"],
                "trackCount": self.data["trackCount"], "sceneCount": self.data["scenes"],
                "anchoredTracks": len(self.bindings), "duplicateReferencesRemoved": self.duplicates,
                "supportedEvents": sum(e.get("tracking", {}).get("status") == "supported" for e in events),
                "unresolvedEvents": sum(e.get("tracking", {}).get("status") != "supported" for e in events),
                "limitations": "Scene-local image-space tracks, not verified identities. No cross-cut re-identification, ball tracking, speed or distance measurements."}

    def annotate(self, source: Path, target: Path, begin, end):
        """Render physical T IDs on video, preserving source time and ten-fps input."""
        import av
        import cv2
        import subprocess

        # Reuse the bounded source section; draw on it without changing its clock.
        capture = cv2.VideoCapture(str(source))
        fps = capture.get(cv2.CAP_PROP_FPS)
        width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if fps <= 0 or width <= 0 or height <= 0:
            capture.release()
            raise JobFailure("tracking_decode_failed", "The tracking video could not be decoded.")
        writer = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "23", "-threads", "2", "-movflags", "+faststart", str(target)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            index = 0
            while True:
                ok, image = capture.read()
                if not ok:
                    break
                at = begin + index / fps
                frame = self.at(at)
                if frame:
                    for p in frame["people"]:
                        x1,y1,x2,y2 = [int(x*s/1000) for x,s in zip(p["box"], [width,height,width,height])]
                        cv2.rectangle(image, (x1,y1), (x2,y2), (0,255,255), 1)
                        cv2.putText(image, p["id"], (x1,max(15,y1-3)), cv2.FONT_HERSHEY_SIMPLEX, .5, (0,255,255), 2)
                writer.stdin.write(image.tobytes())
                index += 1
                if index / fps > end-begin+1:
                    raise JobFailure("tracking_decode_failed", "Tracking section duration was inconsistent.")
            writer.stdin.close()
            if writer.wait(timeout=120) != 0:
                raise JobFailure("tracking_decode_failed", "The tracking overlay could not be encoded.")
        finally:
            capture.release()
            if writer.poll() is None:
                writer.kill()
            writer.wait()
