"""python -m voice bench|accuracy|live|synth ... (run on George from C:\\Users\\owner\\capri-voice)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser(prog="voice")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bench")
    b.add_argument("--models", default="qwen2.5:7b-instruct-q4_K_M,llama3.2:3b-instruct-q4_K_M")
    b.add_argument("--stt", default="large-v3-turbo")
    b.add_argument("--silence-ms", type=int, default=400)
    b.add_argument("--out", default=str(HERE / "runs" / "bench"))
    a = sub.add_parser("accuracy")
    a.add_argument("--models", default="qwen2.5:7b-instruct-q4_K_M,llama3.2:3b-instruct-q4_K_M")
    a.add_argument("--out", default=str(HERE / "runs" / "bench"))
    s = sub.add_parser("synth")
    s.add_argument("--out", default=str(HERE / "inputs"))
    rp = sub.add_parser("report")
    rp.add_argument("jsonl", nargs="+")
    ac = sub.add_parser("acoustic")
    ac.add_argument("wav")
    lv = sub.add_parser("live")
    lv.add_argument("--model", default="qwen2.5:7b-instruct-q4_K_M")
    lv.add_argument("--stt", default="large-v3-turbo")
    lv.add_argument("--silence-ms", type=int, default=400)
    lv.add_argument("--mic", default="Anker")
    lv.add_argument("--speaker", default=None)
    lv.add_argument("--seconds", type=float, default=120)
    lv.add_argument("--play-inputs", action="store_true")
    lv.add_argument("--live-actions", action="store_true", help="really call capri-hands (default: dry)")
    lv.add_argument("--out", default=str(HERE / "runs" / "live"))
    for sp in (b, a, s, lv):
        sp.add_argument("--phrases", choices=["mixed", "en"], default="mixed")
    for sp in (b, lv):
        sp.add_argument("--stt-lang", choices=["es", "en"], default=None, help="fix the STT language (skip language ID)")
    args = ap.parse_args()

    if args.cmd == "bench":
        from . import bench
        bench.run(args.models.split(","), args.stt.split(","), args.silence_ms, Path(args.out),
                  set_name=args.phrases, stt_lang=args.stt_lang)
    elif args.cmd == "accuracy":
        from . import bench
        rows = bench.text_accuracy(args.models.split(","), Path(args.out), set_name=args.phrases)
        for r in rows:
            print(json.dumps(r, ensure_ascii=False))
    elif args.cmd == "report":
        from . import core
        rows = [json.loads(line) for f in args.jsonl for line in open(f, encoding="utf-8") if line.strip()]
        print(core.report([r for r in rows if "e2e_ms" in r]))
    elif args.cmd == "acoustic":
        from . import bench
        print(json.dumps(bench.acoustic(Path(args.wav))))
    elif args.cmd == "synth":
        from . import bench
        from .mouth import Tts
        from . import core
        out = Path(args.out) if args.phrases == "mixed" else HERE / core.inputs_dir_name(args.phrases)
        bench.synth_inputs(Tts(), out, core.phrase_set(args.phrases))
    elif args.cmd == "live":
        from . import live
        live.run(args.model, args.stt, args.silence_ms, Path(args.out), mic=args.mic, speaker=args.speaker,
                 seconds=args.seconds, play_inputs=args.play_inputs, dry=not args.live_actions,
                 set_name=args.phrases, stt_lang=args.stt_lang)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
