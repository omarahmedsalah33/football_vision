"""Computer-vision analysis of a calibrated, fixed-camera match video.

Pipeline: decode sampled frames → detect people → track identities → project feet onto the pitch →
split teams by shirt colour → compute metrics with provenance and quality indicators.

Each stage sits behind a small interface (Detector, Tracker) so models can be upgraded or replaced
without touching the rest, and every run records which implementation and settings produced it.
"""
