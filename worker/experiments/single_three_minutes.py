"""Explicit one-section experiment. No website jobs or production settings are changed."""
import ast
import base64
import inspect
import json
import time
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

from experiments.compare_tracking import LocalSaved
from experiments.full_latest import FullProvider
from fa_worker.action_first import analyze_actions, segment
from fa_worker.video_events import command, validate_events


def discovery_prompt(duration):
    """Reuse the exact current detection prompt, changing only the section duration."""
    tree = ast.parse(inspect.getsource(analyze_actions))
    scope = {"fast": True, "select_photos": True, "game_stats": True,
             "begin": 0, "context_end": duration, "json": json}
    for statement in tree.body[0].body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in ("photo_prompt", "extended", "event_types")
            for target in statement.targets
        ):
            exec(compile(ast.Module(body=[statement], type_ignores=[]), "<discovery-constants>", "exec"), scope)
    discover = next(n for n in tree.body[0].body if isinstance(n, ast.FunctionDef) and n.name == "discover")
    call = next(n for n in ast.walk(discover) if isinstance(n, ast.Call)
                and isinstance(n.func, ast.Attribute) and n.func.attr == "call")
    return eval(compile(ast.Expression(call.args[1]), "<discovery-prompt>", "eval"), scope)


def compare(previous, current):
    # One-to-one temporal agreement, not a ground-truth accuracy score.
    pairs = sorted((abs(a["key"]-b["key"]), i, j)
                   for i, a in enumerate(previous) for j, b in enumerate(current)
                   if a["type"] == b["type"] and abs(a["key"]-b["key"]) <= 2)
    used_a, used_b, matches = set(), set(), []
    for distance, i, j in pairs:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        matches.append({"baseline": previous[i], "single": current[j], "timeDifference": distance,
                        "sameOutcome": previous[i]["outcome"] == current[j]["outcome"]})
    return {"baselineCount": len(previous), "singleCount": len(current),
            "baselineTypes": dict(Counter(e["type"] for e in previous)),
            "singleTypes": dict(Counter(e["type"] for e in current)),
            "matches": matches,
            "baselineOnly": [e for i, e in enumerate(previous) if i not in used_a],
            "singleOnly": [e for j, e in enumerate(current) if j not in used_b],
            "caveat": "Same type within two seconds is agreement, not proof of correctness. Baseline is not ground truth."}


def run():
    out = Path("generated-artifacts/single-three-minutes-20261026")
    out.mkdir(parents=True, exist_ok=True)
    status = out/"status.json"
    started = time.monotonic()
    status.write_text(json.dumps({"status": "encoding"}))
    try:
        video = segment(Path("generated-artifacts/football-first-three-minutes.mp4"),
                        out/"full-section.mp4", 0, 180, command)
        prompt = discovery_prompt(180)
        (out/"prompt.txt").write_text(prompt)
        provider = FullProvider(SimpleNamespace(storage_provider="replit",
            worker_storage_url="https://experiment.invalid/internal/storage",
            worker_storage_token="unused", worker_id="one-section-experiment"),
            SimpleNamespace(id=out.name), LocalSaved(), out/"checkpoints", lambda: None)
        provider.stage = "llm_events"
        payload = json.dumps({"prompt": prompt, "images": [], "video": base64.b64encode(video).decode()}).encode()
        # Direct experimental transport: do not change the website's smaller broker cap.
        # Preserve the same encoding, model, sampling and output budget as the baseline.
        status.write_text(json.dumps({"status": "requesting", "videoBytes": len(video),
                                     "payloadBytes": len(payload), "durationSeconds": 180}))
        print("SINGLE_REQUEST", len(video), "video bytes", flush=True)
        request_start = time.monotonic()
        raw = provider._request(payload, "gemini", "single-three-minutes")
        (out/"response.json").write_text(json.dumps(raw))
        candidate = raw.get("candidates", [{}])[0]
        if not raw.get("modelVersion", "").startswith("gemini-3.8-flash"):
            raise ValueError("Unexpected model")
        if candidate.get("finishReason") != "STOP":
            raise ValueError("Incomplete response: " + str(candidate.get("finishReason")))
        if not any(p.get("modality") == "VIDEO" and p.get("tokenCount", 0) > 0
                   for p in raw.get("usageMetadata", {}).get("promptTokensDetails", [])):
            raise ValueError("Video input not acknowledged")
        answer = json.loads("".join(p.get("text", "") for p in candidate["content"]["parts"] if not p.get("thought")))
        events = validate_events(answer, 180, set())
        (out/"events.json").write_text(json.dumps(events, indent=2))
        baseline = json.loads(Path("generated-artifacts/full-latest-20261026T151234Z/before-parallel-result.json").read_text())
        baseline_events = [e for e in baseline["summary"]["videoEvents"]["events"] if not e.get("duplicateOf")]
        report = compare(baseline_events, events)
        report.update(requestSeconds=time.monotonic()-request_start, totalSeconds=time.monotonic()-started,
                      attempts=provider.requests, usage=raw.get("usageMetadata"), videoBytes=len(video))
        (out/"comparison.json").write_text(json.dumps(report, indent=2))
        status.write_text(json.dumps({"status": "succeeded", "baselineCount": len(baseline_events),
            "singleCount": len(events), "matched": len(report["matches"]), "seconds": report["requestSeconds"]}))
        print("SINGLE_COMPLETE", status.read_text(), flush=True)
    except Exception as error:
        status.write_text(json.dumps({"status": "failed", "errorType": type(error).__name__,
                                     "code": getattr(error, "code", None), "seconds": time.monotonic()-started}))
        print("SINGLE_FAILED", status.read_text(), flush=True)
        raise


if __name__ == "__main__":
    run()
