"""Silero VAD (onnx, streaming, 32 ms frames) and faster-whisper STT on CUDA."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import numpy as np

from . import core

SR = 16000
FRAME = 512  # 32 ms at 16 kHz
HERE = Path(__file__).resolve().parents[1]


def add_cuda_dlls() -> None:
    """faster-whisper (CTranslate2) needs cuBLAS 12 and cuDNN 9; the pip wheels put them under nvidia/*/bin."""
    if sys.platform != "win32":
        return
    import site

    for sp in site.getsitepackages():
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc", "cufft", "curand"):
            d = Path(sp) / "nvidia" / sub / "bin"
            if d.is_dir():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


class Vad:
    """Streaming Silero v5. feed() one 512-sample frame, get the speech probability."""

    def __init__(self, model: Path | None = None):
        import onnxruntime as ort

        model = model or HERE / "models" / "silero_vad.onnx"
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.sess = ort.InferenceSession(str(model), opts, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros((1, 64), dtype=np.float32)

    def feed(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.ctx, frame.reshape(1, -1).astype(np.float32)], axis=1)
        out, self.state = self.sess.run(None, {"input": x, "state": self.state, "sr": np.array(SR, dtype=np.int64)})
        self.ctx = x[:, -64:]
        return float(out[0][0])


class Endpointer:
    """Speech start/end from per-frame probabilities: end after `silence_ms` below threshold."""

    def __init__(self, threshold: float = 0.5, silence_ms: int = 400, min_speech_ms: int = 160):
        self.th, self.neg = threshold, threshold - 0.15
        self.silence_frames = max(1, silence_ms // 32)
        self.min_speech = max(1, min_speech_ms // 32)
        self.reset()

    def reset(self):
        self.in_speech, self.speech_frames, self.quiet = False, 0, 0

    def step(self, prob: float) -> str | None:
        """Returns 'start', 'end' or None."""
        if not self.in_speech:
            if prob >= self.th:
                self.speech_frames += 1
                if self.speech_frames >= 2:
                    self.in_speech, self.quiet = True, 0
                    return "start"
            else:
                self.speech_frames = 0
            return None
        if prob < self.neg:
            self.quiet += 1
            if self.quiet >= self.silence_frames:
                long_enough = self.speech_frames >= self.min_speech
                self.reset()
                return "end" if long_enough else None
        else:
            self.quiet = 0
            self.speech_frames += 1
        return None


class Stt:
    def __init__(self, size: str = "large-v3-turbo", compute: str = "int8_float16", device: str = "cuda",
                 lang: str | None = None):
        """lang fixes the language (skips language ID); None picks es or en per utterance."""
        add_cuda_dlls()
        self.lang = lang
        from faster_whisper import WhisperModel

        self.size = size
        local = HERE / "models" / f"faster-whisper-{size}"  # copied from hqbox; HF ids pinned in README
        self.model = WhisperModel(str(local) if local.is_dir() else size, device=device, compute_type=compute)

    def __call__(self, audio: np.ndarray, prompt: str = "Capri, Spotify, YouTube, orquestador, acme.") -> dict:
        """One encoder pass for both language ID and decoding.

        faster-whisper's transcribe(language=None) encodes the audio twice (once to detect the language,
        once to decode): 470 ms against 242 ms with the language fixed on large-v3-turbo. Here the
        encoder output is shared. Only es or en is accepted: short commands score low on language ID
        ('Sube el volumen' came back as English 'Subel Volumen' at p=0.27 on small)."""
        from faster_whisper.audio import pad_or_trim
        from faster_whisper.tokenizer import Tokenizer

        t0 = time.perf_counter()
        m = self.model
        enc = m.encode(pad_or_trim(m.feature_extractor(audio.astype(np.float32))))
        if self.lang:
            probs, detected, lang = {self.lang: 1.0}, self.lang, self.lang
        else:
            probs = {tok[2:-2]: p for tok, p in m.model.detect_language(enc)[0]}
            detected = max(probs, key=probs.get)
            lang = core.pick_lang(detected, probs)
        tok = Tokenizer(m.hf_tokenizer, True, task="transcribe", language=lang)
        ids = [tok.sot_prev] + tok.encode(" " + prompt) + list(tok.sot_sequence) + [tok.no_timestamps]
        res = m.model.generate(enc, [ids], beam_size=1, max_length=128, suppress_blank=True)
        out = [t for t in res[0].sequences_ids[0] if t < tok.eot]
        return {"text": tok.decode(out).strip(), "lang": lang, "lang_p": round(probs[detected], 2),
                "detected": detected, "redo": lang != detected, "ms": (time.perf_counter() - t0) * 1000}
