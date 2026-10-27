"""Explicit, private three-minute detector benchmark. No website jobs are claimed."""
from pathlib import Path
import sys
import modal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from modal_app import tracking_image

app = modal.App("football-vision-tracking-benchmark")


@app.function(image=tracking_image.add_local_file(str(Path(__file__).resolve().parents[1]/"modal_app.py"),
                                               "/opt/modal_app.py", copy=True),
              gpu="T4", cpu=4, memory=16384, timeout=3600, scaledown_window=2)
def probe(video: bytes):
    import tempfile
    from fa_worker.player_tracking import collect_tracks, pack_tracks
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp)/"test.mp4"
        source.write_bytes(video)
        return pack_tracks(collect_tracks(source))


@app.local_entrypoint()
def main(output_dir: str = "generated-artifacts/tracking-continuity-v2"):
    source = Path("generated-artifacts/football-first-three-minutes.mp4")
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    result = probe.remote(source.read_bytes())
    (target/"player-tracks.json.gz").write_bytes(result)
    print("Private three-minute tracking result saved.", flush=True)
