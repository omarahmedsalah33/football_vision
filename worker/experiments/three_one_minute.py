"""Three concurrent one-minute sections, original encoding; no website changes."""
import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from experiments.compare_tracking import LocalSaved
from experiments.full_latest import FullProvider
from experiments.single_three_minutes import compare, discovery_prompt
from fa_worker.action_first import segment
from fa_worker.video_events import command, validate_events

OUT = Path("generated-artifacts/three-one-minute-20261026")


def run_section(index):
    out = OUT/f"section-{index+1}"
    out.mkdir(parents=True, exist_ok=True)
    start = index*60
    finish = min(start+62, 180)
    begun = time.monotonic()
    try:
        video = segment(Path("generated-artifacts/football-first-three-minutes.mp4"),
                        out/"clip.mp4", start, finish, command)
        prompt = discovery_prompt(finish-start)
        (out/"prompt.txt").write_text(prompt)
        provider = FullProvider(SimpleNamespace(storage_provider="replit",
            worker_storage_url="https://experiment.invalid/internal/storage",
            worker_storage_token="unused", worker_id="three-one-minute"),
            SimpleNamespace(id=out.name), LocalSaved(), out/"checkpoints", lambda: None)
        provider.stage = "llm_events"
        payload = json.dumps({"prompt": prompt, "images": [],
                              "video": base64.b64encode(video).decode()}).encode()
        requested = time.monotonic()
        print("SECTION_REQUEST", index+1, "videoBytes", len(video), flush=True)
        raw = provider._request(payload, "gemini", f"minute-{index+1}")
        candidate = raw.get("candidates", [{}])[0]
        if not raw.get("modelVersion", "").startswith("gemini-3.8-flash"):
            raise ValueError("Unexpected model")
        if candidate.get("finishReason") != "STOP":
            raise ValueError("Incomplete response: "+str(candidate.get("finishReason")))
        if not any(p.get("modality") == "VIDEO" and p.get("tokenCount", 0) > 0
                   for p in raw.get("usageMetadata", {}).get("promptTokensDetails", [])):
            raise ValueError("Video input not acknowledged")
        response = json.loads("".join(p.get("text", "") for p in candidate["content"]["parts"] if not p.get("thought")))
        local = validate_events(response, finish-start, set())
        events = [{**e, **{key: round(e[key]+start, 3) for key in ("start", "end", "key")}}
                  for e in local if e["key"] < 60]
        result = {"status": "succeeded", "section": index+1, "events": events,
                  "requestSeconds": time.monotonic()-requested, "seconds": time.monotonic()-begun,
                  "videoBytes": len(video), "attempts": provider.requests}
    except Exception as error:
        result = {"status": "failed", "section": index+1, "errorType": type(error).__name__,
                  "code": getattr(error, "code", None), "seconds": time.monotonic()-begun}
    (out/"result.json").write_text(json.dumps(result, indent=2))
    print("SECTION_DONE", index+1, result["status"], flush=True)
    return result


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    (OUT/"status.json").write_text(json.dumps({"status": "running", "sections": 3, "concurrency": 3}))
    with ThreadPoolExecutor(max_workers=3) as pool:
        sections = list(pool.map(run_section, range(3)))
    result = {"status": "succeeded" if all(s["status"] == "succeeded" for s in sections) else "failed",
              "seconds": time.monotonic()-started, "sections": sections}
    if result["status"] == "succeeded":
        baseline = json.loads(Path("generated-artifacts/full-latest-20261026T151234Z/before-parallel-result.json").read_text())
        previous = [e for e in baseline["summary"]["videoEvents"]["events"] if not e.get("duplicateOf")]
        current = [e for s in sections for e in s["events"]]
        comparison = compare(previous, current)
        (OUT/"comparison.json").write_text(json.dumps(comparison, indent=2))
        result.update(baselineCount=len(previous), currentCount=len(current), matched=len(comparison["matches"]))
    (OUT/"status.json").write_text(json.dumps(result, indent=2))
    print("EXPERIMENT_DONE", result["status"], "seconds", result["seconds"], flush=True)


if __name__ == "__main__":
    run()
