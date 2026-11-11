// A figure that acknowledges its own change.
//
// The header counts repoll every few seconds, and a number that swaps silently is
// easy to miss and easy to distrust: you cannot tell whether you misread it or it
// moved. So the digit rolls over, once, and only when the value ACTUALLY differs
// from the one already on screen. A re-render carrying the same number is silent,
// which is most renders.
//
// It is deliberately the only place in the console that animates a value. The
// animation is defined in styles.css alongside the rest of the motion budget, and
// it is off entirely under prefers-reduced-motion.
import { useEffect, useRef, useState } from "react";
import { cx } from "./primitives";

export function TickNum({ value, className }: { value: number; className?: string }) {
  const previous = useRef(value);
  const [ticking, setTicking] = useState(false);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setTicking(true);
    // Long enough to cover the keyframe, then cleared so the next change can
    // retrigger it. Cleared on unmount too, or a fast tab switch sets state on a
    // component that is already gone.
    const timer = window.setTimeout(() => setTicking(false), 320);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <b
      // The number is announced as a whole when it changes rather than digit by
      // digit, so a screen reader gets "3" and not the animation.
      aria-live="polite"
      className={cx("inline-block font-semibold tabular-nums", ticking && "hq-tick", className)}
    >
      {value}
    </b>
  );
}
