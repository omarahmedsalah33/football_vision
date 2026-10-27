"""Opt-in local three-minute AI comparison. Never claims website/production jobs.

Uses the same models, native-video sampling and output budgets as the website broker.
Generated responses stay private under generated-artifacts, not in source control.
"""
from __future__ import annotations
import argparse
import gzip
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from fa_worker.errors import JobFailure
from fa_worker.video_provider import VideoProvider
from fa_worker.video_events import analyze, analyze_gallery
from fa_worker.player_tracking import TrackingEvidence, unpack_tracks


class LocalSaved:
    def publish(self, path):
        pass

    def restore(self, directory, progress):
        directory.mkdir(parents=True, exist_ok=True)
        return list(directory.glob("llm-*.json.gz"))


class ExperimentProvider(VideoProvider):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.next_request = {}

    def _send(self, req, provider):
        """Single-flight benchmark calls, with bounded cooldowns; never cache a 429."""
        for attempt in range(4):
            delay = max(0, self.next_request.get(provider, 0)-time.monotonic())
            if delay:
                print(provider, "cooldown", round(delay), "seconds", flush=True)
                time.sleep(delay)
                self.cooldown_seconds = getattr(self,"cooldown_seconds",0)+delay
            self.next_request[provider] = time.monotonic()+60
            try:
                self.http_attempts = getattr(self,"http_attempts",0)+1
                with urlopen(req, timeout=260) as response:
                    return json.load(response)
            except HTTPError as error:
                if error.code == 429 and attempt < 3:
                    try:
                        retry_after = float(error.headers.get("Retry-After", "0"))
                    except (TypeError, ValueError):
                        retry_after = 0
                    # Do not exceed the benchmark's bounded automatic-wait budget.
                    if retry_after > 600:
                        raise JobFailure("ai_rate_limited", f"{provider} requested a longer cooldown; comparison paused.") from None
                    wait = max(60 * 2**attempt, retry_after)
                    self.next_request[provider] = time.monotonic()+wait
                    print(provider, "rate limited; retry", attempt+1, "after", round(wait), "seconds", flush=True)
                    continue
                code = "ai_rate_limited" if error.code == 429 else "ai_provider_error"
                raise JobFailure(code, f"{provider} returned HTTP {error.code}; comparison paused after bounded retries.") from None
            except (URLError, TimeoutError):
                raise JobFailure("ai_provider_unavailable", f"{provider} did not complete; comparison paused.") from None

    def _request(self, payload, provider, fingerprint):
        body = json.loads(payload)
        if provider == "gemini":
            base = os.environ["AI_INTEGRATIONS_GEMINI_BASE_URL"].rstrip("/")
            key = os.environ["AI_INTEGRATIONS_GEMINI_API_KEY"]
            url = base + "/models/gemini-3.8-flash:generateContent"
            parts = [{"text": body["prompt"]}] + [
                {"inlineData": {"mimeType": "image/jpeg", "data": image}} for image in body["images"]]
            if body.get("video"):
                parts.append({"inlineData": {"mimeType": "video/mp4", "data": body["video"]},
                              "videoMetadata": {"fps": 10}})
            request_body = {"contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"temperature": .1, "maxOutputTokens": 24576, "responseMimeType": "application/json"}}
            headers = {"x-goog-api-key": key}
        else:
            base = os.environ["AI_INTEGRATIONS_OPENAI_BASE_URL"].rstrip("/")
            key = os.environ["AI_INTEGRATIONS_OPENAI_API_KEY"]
            url = base + "/chat/completions"
            request_body = {"model": "gpt-6-astra", "max_completion_tokens": 10000,
                "response_format": {"type": "json_object"}, "messages": [{"role": "user", "content":
                    [{"type": "text", "text": body["prompt"]}] + [{"type": "image_url", "image_url":
                     {"url": "data:image/jpeg;base64," + image, "detail": "high"}} for image in body["images"]]}]}
            headers = {"Authorization": "Bearer " + key}
        req = Request(url, json.dumps(request_body).encode(), {"Content-Type": "application/json", **headers})
        result = self._send(req, provider)
        (self.directory/f"raw-{fingerprint}.json").write_text(json.dumps(result))
        return result


def run(mode):
    source = Path("generated-artifacts/football-first-three-minutes.mp4")
    root = Path("generated-artifacts/tracking-comparison")
    out = root/mode
    out.mkdir(parents=True, exist_ok=True)
    if mode == "full-gallery":
        # Preserve the exact seed labels in the photo PDF already delivered for
        # this clip. Only the identical bootstrap request is reused; the full
        # gallery scan, events and Astra checks have different inference inputs.
        checkpoints = out/"checkpoints"
        checkpoints.mkdir(exist_ok=True)
        if not list(checkpoints.glob("llm-*.json.gz")):
            seeds = [p for p in (root/"single-frame"/"checkpoints").glob("llm-*.json.gz")
                     if isinstance((r:=json.loads(gzip.decompress(p.read_bytes())).get("result")),dict)
                     and "players" in r]
            if len(seeds)==1:
                (checkpoints/seeds[0].name).write_bytes(seeds[0].read_bytes())
    if mode == "tracking-v3":
        # Controlled comparison: the exact same 22s/24s reference request was
        # already answered in baseline. Reuse ONLY that saved roster response;
        # event clips, prompts and reviews must be newly inferred for v3.
        checkpoints = out/"checkpoints"
        checkpoints.mkdir(exist_ok=True)
        if not list(checkpoints.glob("llm-*.json.gz")):
            roster = [p for p in (root/"baseline"/"checkpoints").glob("llm-*.json.gz")
                      if "players" in json.loads(gzip.decompress(p.read_bytes())).get("result", {})]
            if len(roster) != 1:
                raise RuntimeError("Expected one saved baseline roster for the same private clip.")
            (checkpoints/roster[0].name).write_bytes(roster[0].read_bytes())
    saved = LocalSaved()
    provider = ExperimentProvider(
        SimpleNamespace(storage_provider="replit", worker_storage_url="https://experiment.invalid/internal/storage",
                        worker_storage_token="unused", worker_id="local-explicit-comparison"),
        SimpleNamespace(id="three-minute-tracking-comparison"), saved, out/"checkpoints", lambda: None)
    path = (Path("generated-artifacts/tracking-continuity-v3-guarded/player-tracks.json.gz")
            if mode == "tracking-v3" else root/"player-tracks.json.gz")
    tracking = (TrackingEvidence(unpack_tracks(path.read_bytes()))
                if mode in {"tracking", "tracking-v3"} else None)
    if mode == "tracking-v3" and tracking.data["version"] != "rfdetr-bytetrack-v3":
        raise RuntimeError("The guarded trajectory is not the version requested.")
    start = time.monotonic()
    (out/"status.json").write_text(json.dumps({"status": "running", "mode": mode}))
    try:
        analysis = analyze_gallery if mode=="full-gallery" else analyze
        result = analysis(source, out, 180, provider,
                         lambda stage, fraction: print(mode, stage, round(fraction, 3), flush=True), tracking=tracking)
        (out/"status.json").write_text(json.dumps({"status": "succeeded", "seconds": time.monotonic()-start}))
        print(mode, "complete", "players", len(result["summary"]["videoEvents"]["catalog"]), flush=True)
    except JobFailure as error:
        (out/"status.json").write_text(json.dumps({"status": "blocked", "code": error.code,
            "message": error.user_message, "seconds": time.monotonic()-start}))
        print(mode, "blocked", error.code, flush=True)
        raise SystemExit(2) from None
    except Exception as error:
        (out/"status.json").write_text(json.dumps({"status":"failed",
            "errorType":type(error).__name__, "seconds":time.monotonic()-start}))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["baseline", "tracking", "tracking-v3", "single-frame", "full-gallery", "action-first"])
    run(parser.parse_args().mode)
