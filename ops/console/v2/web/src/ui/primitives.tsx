// Small presentational primitives. Everything the console draws is built from these, so
// the direction switch stays a token change: no component hard-codes a color.

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { useContext } from "react";
import { sigilColor, sigilFor, sigilsEnabled } from "./sigil";
import { FoldContext, FoldToggle, HeadFoldContext, useHeadFold } from "./Fold";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- Card ----------

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  // A <Fold> around this card (ui/Fold.tsx) folds it to its head. The fold goes to this
  // card's head only: nested cards see no fold.
  const fold = useContext(FoldContext);
  return (
    <div
      {...rest}
      data-folded={fold?.folded ? "" : undefined}
      className={cx(
        "hq-card bg-panel border border-line rounded-card shadow-card min-w-0",
        // Teletype punches sprocket holes down the left margin of every card, so a
        // panel reads as a torn-off page.
        "hq-feed",
        className,
      )}
    >
      <FoldContext.Provider value={null}>
        <HeadFoldContext.Provider value={fold}>{children}</HeadFoldContext.Provider>
      </FoldContext.Provider>
    </div>
  );
}

export function CardHead({
  title,
  chip,
  actions,
}: {
  title: ReactNode;
  chip?: ReactNode;
  actions?: ReactNode;
}) {
  const fold = useHeadFold();
  return (
    <div className="hq-card-head flex items-center justify-between gap-2 flex-wrap px-3.5 py-2.5 border-b border-line">
      <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.06em] text-mute">
        {fold ? <FoldToggle fold={fold} title={title} /> : title}
      </h2>
      <div className="flex items-center gap-1.5 flex-wrap">
        {chip}
        {actions}
      </div>
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx("px-3.5 py-3", className)}>
      {children}
    </div>
  );
}

// ---------- Chip ----------

export type ChipTone = "default" | "ok" | "warn" | "bad" | "accent" | "mute";

const CHIP_TONE: Record<ChipTone, string> = {
  default: "bg-chip text-ink",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  accent: "bg-accent/20 text-accent",
  mute: "bg-chip text-mute",
};

export function Chip({
  tone = "default",
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("inline-block rounded-sub px-1.5 py-px text-[11px] leading-5", CHIP_TONE[tone], className)}>
      {children}
    </span>
  );
}

// ---------- Badge ----------

// ---------- Rig sigil ----------

/** The mark for a project, drawn wherever its name appears. Pure function of the id
 *  (ui/sigil.ts), so a project that did not exist yesterday has a mark today. The text
 *  label always stays beside it: this is a scanning aid, never the only identifier. */
export function RigSigil({ id, size = 14, className }: { id: string | null | undefined; size?: number; className?: string }) {
  if (!id || !sigilsEnabled()) return null;
  const sigil = sigilFor(id);
  const color = sigilColor(sigil);
  const cells = [];
  for (let i = 0; i < sigil.cells.length; i++) {
    if (!sigil.cells[i]) continue;
    cells.push(<rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" fill={color} />);
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={`${id} mark`}
      style={{ flex: "0 0 auto", verticalAlign: "-0.15em" }}
    >
      {cells}
    </svg>
  );
}

// ---------- Capri wordmark ----------

/** The meta terminal's name, wherever it is rendered as UI text. The whole
 *  treatment lives in .hq-capri (styles.css); this is the only place the word is
 *  built, so it can never be half-applied and no site copy-pastes the styles.
 *
 *    full   ink, letterform halo, breathing bloom   rail button, card title
 *    quiet  ink and halo, no bloom, no motion       inside a Chip, running prose
 *    plain  inherits the ink it sits on             filled primary Button
 *
 *  Never use this for an aria-label, a title attribute or a toast string: those are
 *  plain strings and must stay plain. */
export function CapriWord({
  tone = "full",
  className,
}: {
  tone?: "full" | "quiet" | "plain";
  className?: string;
}) {
  return (
    <span
      className={cx("hq-capri", tone === "quiet" && "hq-capri--quiet", tone === "plain" && "hq-capri--plain", className)}
    >
      Capri
    </span>
  );
}

export function Badge({ count, tone }: { count: number; tone: "p0" | "p1" | "neutral" | "none" }) {
  if (tone === "none" || count <= 0) return null;
  const style =
    tone === "p0"
      ? "bg-p0 text-white"
      : tone === "p1"
        ? "bg-p1 text-white"
        : "bg-chip text-mute";
  return (
    <span className={cx("min-w-5 rounded-full px-1.5 py-px text-center text-[11px] leading-4", style)}>
      {count}
    </span>
  );
}

// ---------- Button ----------

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "bg-panel border-line text-ink hover:bg-panel2",
  primary: "bg-accent border-accent text-accent-ink hover:opacity-90",
  danger: "bg-panel border-p0 text-p0 hover:bg-p0/10",
  ghost: "bg-transparent border-transparent text-mute hover:bg-panel2 hover:text-ink",
};

export function Button({ variant = "default", size = "md", className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sub border cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        // Press feedback on every control in the console. Understated on purpose:
        // some of these buttons start a session or merge a branch, and a bouncy
        // control makes a consequential gesture feel casual.
        "hq-press",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]",
        BUTTON_VARIANT[variant],
        className,
      )}
    />
  );
}

export function ButtonRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}

// ---------- Inputs ----------

export const inputClass =
  "w-full rounded-sub border border-line bg-panel px-2 py-1.5 text-[13px] text-ink placeholder:text-faint";

// ---------- Table ----------

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto hq-scroll">{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full border-collapse text-[13px]">{children}</table>;
}

export function Th({ children, numeric }: { children?: ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-line px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-mute",
        numeric ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  colSpan,
}: {
  children?: ReactNode;
  numeric?: boolean;
  /** For a row that spans the table, such as a section header inside a list. */
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx("border-b border-line px-2 py-1.5 align-middle", numeric && "text-right font-mono text-[12px]")}
    >
      {children}
    </td>
  );
}

// ---------- Misc ----------

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="bg-panel border border-line rounded-card px-3 py-2.5">
      <span className="block text-[11px] uppercase tracking-[0.05em] text-mute">{label}</span>
      <b className="block font-mono text-[20px] font-semibold leading-tight">{value}</b>
      {detail ? <span className="block text-[11px] text-mute">{detail}</span> : null}
    </div>
  );
}

export function Sparkline({
  points,
  label,
  stroke = "var(--accent)",
  height = 36,
}: {
  points: readonly number[];
  label?: string;
  stroke?: string;
  height?: number;
}) {
  if (points.length < 2) {
    return <div className="h-9" aria-hidden="true" />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = 300 / (points.length - 1);
  const path = points
    .map((value, index) => {
      const x = Math.round(index * stepX * 100) / 100;
      const y = Math.round((32 - ((value - min) / span) * 28) * 100) / 100;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      className="block w-full"
      style={{ height }}
      viewBox="0 0 300 36"
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? "trend"}
    >
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={path} />
    </svg>
  );
}

export function ProgressBar({ value, width = 110 }: { value: number; width?: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <span
      className="inline-block h-1.5 overflow-hidden rounded-full bg-panel2 align-middle"
      style={{ width }}
      role="img"
      aria-label={`${Math.round(clamped * 100)} percent`}
    >
      <i className="block h-full bg-accent" style={{ width: `${clamped * 100}%` }} />
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="my-2.5 border-l-2 border-line px-2.5 py-0.5 text-[12px] text-mute">{children}</p>;
}

export function Placeholder({ phase, children }: { phase: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-panel2/40 px-3.5 py-3 text-[12px] text-mute">
      <Chip tone="accent">{phase}</Chip> <span className="ml-1.5">{children}</span>
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="m-0 text-[18px] font-semibold text-balance">{title}</h1>
        {sub ? <p className="mt-1 mb-0 max-w-[70ch] text-[13px] text-mute">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}
