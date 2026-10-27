"""Optional MIT-licensed football-specific baseline, fetched only for explicit experiments.

FootAndBall (Komorowski, Kurzejamski, Sarwas; VISAPP 2020).
https://github.com/jac99/FootAndBall
Source and weights pinned to the upstream revision below, with Git blob verification.
It is not a validated model for amateur low-resolution night footage.
"""
from pathlib import Path

REVISION = "01261092a93de55026745e532a2e12188ad86801"
BLOBS = {
    "LICENSE": "d1a37db661098ba532b197167fa02640e87b3f86",
    "data/augmentation.py": "2623bb2102a0ea1d745026d2d9c1e21e3afce0fa",
    "models/model_20201019_1416_final.pth": "368ef2805765681c01c5687edb3f3c7ee8414a22",
    "network/footandball.py": "738db9c75d4605b28ef7ef5500d81f016f7c663c",
    "network/fpn.py": "f2282d76652d15849cb832b103a451e8567ba1f2",
    "network/nms.py": "3dbc52c7ed130e55a855f16a10b44c654ae25009",
}


def load(cache_dir="/models", device="cuda"):
    import hashlib
    import sys
    import urllib.request
    import torch

    root = Path(cache_dir) / "footandball" / REVISION
    for name, expected in BLOBS.items():
        path = root / name
        if path.exists():
            data = path.read_bytes()
        else:
            with urllib.request.urlopen(f"https://raw.githubusercontent.com/jac99/FootAndBall/{REVISION}/{name}", timeout=60) as response:
                data = response.read(2 * 1024 * 1024)
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != expected:
            raise ValueError(f"FootAndBall artifact integrity failure: {name}")
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    sys.path.insert(0, str(root))
    from network.footandball import model_factory
    from data.augmentation import numpy2tensor, BALL_LABEL

    model = model_factory("fb1", "detect", ball_threshold=0.7, player_threshold=0.7)
    weights = torch.load(root / "models/model_20201019_1416_final.pth", map_location="cpu", weights_only=True)
    model.load_state_dict(weights)
    model.eval().to(device)
    return model, numpy2tensor, BALL_LABEL
