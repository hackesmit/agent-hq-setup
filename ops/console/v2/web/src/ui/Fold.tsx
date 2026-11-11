// Folding sections (bead hq-4npjr.17). Wrap any Card in <Fold id="..."> and its head
// becomes a toggle: click the title or the chevron and the card shrinks to its head,
// which still carries the card's count chip. The state is kept per section id in
// localStorage, so a folded section stays folded after a reload.
//
// How the body hides: Card reads the fold and sets data-folded on itself; a style rule
// hides every direct child except the head (.hq-card-head). That way no panel needs
// to know it can fold, and a folded card keeps its children mounted (a folded
// terminal keeps its socket). Card resets the context for its own children, so a card
// nested inside a folded card does not grab the outer toggle.

import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

export interface FoldState {
  folded: boolean;
  toggle: () => void;
}

/** Set by <Fold>, read by Card. */
export const FoldContext = createContext<FoldState | null>(null);
/** Set by Card for its own head only. */
export const HeadFoldContext = createContext<FoldState | null>(null);

const PREFIX = "hq.fold.";

export function readFolded(id: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(PREFIX + id) === "1";
  } catch {
    return false;
  }
}

export function saveFolded(id: string, folded: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): void {
  try {
    if (folded) storage?.setItem(PREFIX + id, "1");
    else storage?.removeItem(PREFIX + id);
  } catch {
    /* private mode: the fold lasts this page only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function Fold({ id, children }: { id: string; children?: ReactNode }) {
  const [folded, setFolded] = useState(() => readFolded(id));
  const toggle = useCallback(() => {
    setFolded((value) => {
      saveFolded(id, !value);
      return !value;
    });
  }, [id]);
  return <FoldContext.Provider value={{ folded, toggle }}>{children}</FoldContext.Provider>;
}

/** The chevron plus title button a foldable head shows. Exported for heads that are not CardHead. */
export function FoldToggle({ fold, title, className }: { fold: FoldState; title: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={(className ? className + " " : "") + "hq-fold-toggle m-0 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] font-semibold uppercase tracking-[0.06em] text-mute hover:text-ink"}
      aria-expanded={!fold.folded}
      data-testid="fold-toggle"
      onClick={fold.toggle}
    >
      <span aria-hidden="true" className={fold.folded ? "hq-chev hq-chev-closed" : "hq-chev"}>
        ▾
      </span>
      {title}
    </button>
  );
}

export function useHeadFold(): FoldState | null {
  return useContext(HeadFoldContext);
}

/** For a custom head inside a Card: the toggle when the card is in a <Fold>, else nothing. */
export function HeadFoldToggle({ title, className }: { title: ReactNode; className?: string }) {
  const fold = useHeadFold();
  return fold ? <FoldToggle fold={fold} title={title} className={className} /> : null;
}
