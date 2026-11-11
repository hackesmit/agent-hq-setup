"""Kokoro-82M TTS through kokoro-onnx: Spanish and English voices."""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
VOICES = {"es": ("ef_dora", "es"), "en": ("af_heart", "en-us")}


class Tts:
    def __init__(self, providers: list[str] | None = None):
        from .ears import add_cuda_dlls

        add_cuda_dlls()
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        models = HERE / "models"
        sess = ort.InferenceSession(str(models / "kokoro-v1.0.onnx"),
                                    providers=providers or ["CUDAExecutionProvider", "CPUExecutionProvider"])
        self.provider = sess.get_providers()[0]
        self.k = Kokoro.from_session(sess, str(models / "voices-v1.0.bin"))

    def __call__(self, text: str, lang: str = "es", voice: str | None = None) -> tuple[np.ndarray, int, float]:
        v, code = VOICES.get(lang, VOICES["es"])
        t0 = time.perf_counter()
        audio, sr = self.k.create(text, voice=voice or v, speed=1.1, lang=code)
        return audio, sr, (time.perf_counter() - t0) * 1000
