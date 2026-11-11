// Load images (hq-ymxzt.8): four drop zones, one per state. the owner drops or picks his own
// image files from his PC; each goes to the console, which stores it unchanged in
// state/capri/frames/<state>/ (docs/capri-frames.md). Thumbnails show exactly what
// plays, with a remove button. Nothing is resized, cropped or re-encoded here.
import { useEffect, useRef, useState } from "react";
import type { CapriMood } from "./capri";
import {
  CAPRI_FRAMES_URL,
  capriFileProblem,
  loadCapriFrames,
  onCapriFramesChanged,
  removeCapriFrame,
  uploadCapriFrame,
  type CapriFrames,
} from "./capriFrames";

const STATES: { mood: CapriMood; label: string }[] = [
  { mood: "idle", label: "Idle" },
  { mood: "listening", label: "Listening" },
  { mood: "thinking", label: "Thinking" },
  { mood: "speaking", label: "Speaking" },
];

function useFrames(): CapriFrames {
  const [frames, setFrames] = useState<CapriFrames>({});
  useEffect(() => {
    let live = true;
    const read = (): void => void loadCapriFrames().then((f) => live && setFrames(f ?? {}));
    read();
    const off = onCapriFramesChanged(read);
    return () => {
      live = false;
      off();
    };
  }, []);
  return frames;
}

function Zone({ mood, label, urls }: { mood: CapriMood; label: string; urls: string[] }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function take(list: FileList | File[]): Promise<void> {
    const files = Array.from(list);
    if (!files.length) return;
    setBusy(true);
    const problems: string[] = [];
    for (const f of files) {
      const why = capriFileProblem(f);
      if (why) {
        problems.push(`${f.name}: ${why}`);
        continue;
      }
      try {
        await uploadCapriFrame(mood, f);
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    setBusy(false);
    setMsg(problems.join(" "));
  }

  return (
    <section
      className="hq-capri-zone flex flex-col gap-1.5 rounded-[4px] p-2"
      data-over={over}
      data-state={mood}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] uppercase tracking-[0.14em] text-capri-soft">{label}</h3>
        <button
          type="button"
          className="hq-capri-pick text-[11px]"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Loading…" : "Pick files"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          aria-label={`Pick ${label.toLowerCase()} images`}
          onChange={(e) => {
            void take(e.target.files ?? []);
            e.target.value = "";
          }}
        />
      </div>
      {urls.length === 0 ? (
        <p className="text-[11px]" style={{ color: "var(--capri-soft)" }}>Drop images here</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {urls.map((url) => (
            <li key={url} className="hq-capri-thumb relative h-10 w-10">
              <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
              <button
                type="button"
                className="hq-capri-x absolute -right-1 -top-1 h-4 w-4 text-[10px] leading-none"
                aria-label={`Remove ${url.split("/").pop()}`}
                onClick={() => void removeCapriFrame(url.slice(CAPRI_FRAMES_URL.length + 1)).catch((e) => setMsg(String(e?.message ?? e)))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg ? <p role="alert" className="text-[11px]" style={{ color: "var(--capri-pink)" }}>{msg}</p> : null}
    </section>
  );
}

export function CapriLoadPanel({ onClose }: { onClose: () => void }) {
  const frames = useFrames();
  return (
    <div className="hq-capri-panel flex w-[300px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-[6px] p-3" role="dialog" aria-label="Load images for Capri">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[12px]" style={{ color: "var(--capri-text)" }}>Load images</h2>
        <button type="button" className="hq-capri-pick text-[11px]" onClick={onClose}>Close</button>
      </div>
      <p className="text-[11px]" style={{ color: "var(--capri-soft)" }}>
        Your own png, jpg, webp or gif, up to 5 MB. They play as they are.
      </p>
      {STATES.map((s) => (
        <Zone key={s.mood} mood={s.mood} label={s.label} urls={frames[s.mood]?.frames ?? []} />
      ))}
    </div>
  );
}
