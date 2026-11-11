// Sticky notes: a layer of draggable notes pinned over the whole console.
//
// They sit above every tab, keep their place, and persist on the box, so a note pinned
// on the laptop is in the same corner on the desktop and on the phone. The layer itself
// never eats clicks (pointer-events are off except on the notes), because a scratch pad
// that swallows a button is worse than no scratch pad.
//
// Dragging uses pointer capture rather than window listeners: the note keeps receiving
// moves even when the pointer outruns it, and a released pointer cannot leave a note
// stuck to the cursor. Text and position are saved on a debounce, and the drag saves
// once at the end rather than on every frame.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../data/client";
import { Button } from "../ui/primitives";
import { toastError } from "./toast";

export interface StickyNote {
  id: string;
  text: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
  updatedAt: string;
}

const SAVE_DEBOUNCE_MS = 700;
const COLORS = ["amber", "green", "blue", "pink", "slate"] as const;

/** The store: one fetch on mount, optimistic local edits, debounced writes. */
export function useNotes() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [ready, setReady] = useState(false);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    let live = true;
    api
      .notes()
      .then((list) => {
        if (live) setNotes(list);
      })
      .catch(() => {
        /* an unreachable console is already reported elsewhere */
      })
      .finally(() => live && setReady(true));
    return () => {
      live = false;
      for (const t of timers.current.values()) window.clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  const flush = useCallback((id: string, patch: Partial<StickyNote>) => {
    api.noteUpdate(id, patch).catch(() => toastError("could not save the note"));
  }, []);

  /** Patch locally at once, persist on a debounce (typing and dragging are chatty). */
  const patch = useCallback(
    (id: string, next: Partial<StickyNote>, immediate = false) => {
      setNotes((cur) => cur.map((n) => (n.id === id ? { ...n, ...next } : n)));
      const timer = timers.current.get(id);
      if (timer) window.clearTimeout(timer);
      if (immediate) {
        flush(id, next);
        return;
      }
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          flush(id, next);
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [flush],
  );

  const add = useCallback(async () => {
    // a new note lands near the middle, nudged so a second one does not hide the first
    const jitter = () => (Math.random() - 0.5) * 0.08;
    try {
      const created = await api.noteCreate({ x: 0.5 + jitter(), y: 0.35 + jitter(), color: COLORS[0] });
      setNotes((cur) => [...cur, created]);
      return created;
    } catch {
      toastError("could not create the note");
      return null;
    }
  }, []);

  const remove = useCallback((id: string) => {
    setNotes((cur) => cur.filter((n) => n.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    api.noteDelete(id).catch(() => toastError("could not delete the note"));
  }, []);

  return { notes, ready, add, patch, remove };
}

function colorClass(color: string): string {
  switch (color) {
    case "green":
      return "hq-note-green";
    case "blue":
      return "hq-note-blue";
    case "pink":
      return "hq-note-pink";
    case "slate":
      return "hq-note-slate";
    default:
      return "hq-note-amber";
  }
}

function StickyNoteView({
  note,
  onPatch,
  onRemove,
}: {
  note: StickyNote;
  onPatch: (id: string, next: Partial<StickyNote>, immediate?: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);

  function onPointerDown(e: React.PointerEvent): void {
    // left button (or touch) on the handle only; the textarea keeps its own behavior
    if (e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent): void {
    const d = drag.current;
    if (!d) return;
    const x = (e.clientX - d.dx + note.w / 2) / window.innerWidth;
    const y = (e.clientY - d.dy + 16) / window.innerHeight;
    onPatch(note.id, { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }

  function endDrag(e: React.PointerEvent): void {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    // one authoritative write at the end of the gesture
    onPatch(note.id, { x: note.x, y: note.y }, true);
  }

  // Fractions to pixels, then clamped so a note saved on a wide screen stays reachable
  // on a narrow one instead of hiding past the right edge.
  const left = Math.min(Math.max(note.x * window.innerWidth - note.w / 2, 4), Math.max(4, window.innerWidth - note.w - 4));
  const top = Math.min(Math.max(note.y * window.innerHeight - 16, 4), Math.max(4, window.innerHeight - 60));

  return (
    <div
      ref={ref}
      className={`hq-note ${colorClass(note.color)} ${dragging ? "hq-note-dragging" : ""}`}
      style={{ left, top, width: note.w, height: note.h }}
      role="group"
      aria-label="sticky note"
    >
      <div
        className="hq-note-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="drag to move"
      >
        <span className="hq-note-grip" aria-hidden="true" />
        <span className="hq-note-actions">
          <button type="button" className="hq-note-btn" onClick={() => setMenu((v) => !v)} aria-label="note color">
            color
          </button>
          <button type="button" className="hq-note-btn" onClick={() => onRemove(note.id)} aria-label="delete note">
            delete
          </button>
        </span>
      </div>
      {menu ? (
        <div className="hq-note-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`hq-note-swatch ${colorClass(c)}`}
              aria-label={c}
              onClick={() => {
                onPatch(note.id, { color: c }, true);
                setMenu(false);
              }}
            />
          ))}
        </div>
      ) : null}
      <textarea
        className="hq-note-text"
        value={note.text}
        placeholder="write here"
        spellCheck={false}
        onChange={(e) => onPatch(note.id, { text: e.target.value })}
        onBlur={(e) => onPatch(note.id, { text: e.target.value }, true)}
      />
    </div>
  );
}

/** The layer. Rendered once, above everything, click-through except on the notes. */
export function NotesLayer({
  notes,
  onPatch,
  onRemove,
}: {
  notes: StickyNote[];
  onPatch: (id: string, next: Partial<StickyNote>, immediate?: boolean) => void;
  onRemove: (id: string) => void;
}) {
  // Re-place the notes when the window resizes: they are stored as fractions, so the
  // pixel positions above have to be recomputed.
  const [, force] = useState(0);
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (notes.length === 0) return null;
  return (
    <div className="hq-notes-layer" aria-label="sticky notes">
      {notes.map((note) => (
        <StickyNoteView key={note.id} note={note} onPatch={onPatch} onRemove={onRemove} />
      ))}
    </div>
  );
}

/** The one control that makes a note, for the top strip. */
export function NewNoteButton({ onAdd }: { onAdd: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onAdd} title="pin a sticky note (it stays until you delete it)">
      Note
    </Button>
  );
}
