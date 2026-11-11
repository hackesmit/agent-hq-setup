// The settings dialog: the knobs that belong to this screen.
//
// Every row says what the setting does and, where a number needs a floor, why it has
// one. Changes apply as you make them and are kept per device; there is no Save, because
// there is nothing here that a half-applied state could break.
import { useCallback, useEffect, useState } from "react";
import { Button, cx, inputClass } from "../ui/primitives";
import { DEFAULTS, IDLE_MAX, IDLE_MIN, loadSettings, saveSettings, type Settings as SettingsValue } from "./settings";
import { CUES, inQuietHours, type CueName } from "./cues";

export function useSettings(): [SettingsValue, (patch: Partial<SettingsValue>) => void] {
  const [settings, setSettings] = useState<SettingsValue>(() => loadSettings());
  const update = useCallback((patch: Partial<SettingsValue>) => {
    setSettings((current) => saveSettings({ ...current, ...patch }));
  }, []);
  return [settings, update];
}

function Row({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{title}</div>
        <p className="m-0 mt-0.5 text-[12px] text-mute text-pretty">{note}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <Button size="sm" variant={on ? "primary" : "default"} aria-pressed={on} aria-label={label} onClick={() => onChange(!on)}>
      {on ? "on" : "off"}
    </Button>
  );
}

/** 24-hour labels, so a quiet window reads the way a clock does. */
export function hourLabel(hour: number): string {
  return `${String(((Math.floor(hour) % 24) + 24) % 24).padStart(2, "0")}:00`;
}

/** Whether the quiet window is active right now, for the note under the picker. */
function quietNow(settings: SettingsValue): boolean {
  return settings.sound && inQuietHours(new Date().getHours(), settings.quietFrom, settings.quietTo);
}

function HourPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={cx(inputClass, "w-24 tabular-nums")}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {hourLabel(h)}
        </option>
      ))}
    </select>
  );
}

/**
 * One button per cue. the owner drops sound files into public/cues and names them in
 * cues.json; this is where he hears whether they are levelled against each other without
 * having to provoke a real P0.
 */
function CuePreview({
  onPreview,
  disabled,
  muted,
}: {
  onPreview: (cue: CueName) => void;
  disabled: boolean;
  muted: boolean;
}) {
  const names = Object.keys(CUES) as CueName[];
  const ordered = names.sort((a, b) => CUES[b].salience - CUES[a].salience);
  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="text-[13px] text-ink">Hear them</div>
      <p className="m-0 mt-0.5 mb-2 text-[12px] text-mute text-pretty">
        {disabled
          ? "Sound is off, so these are silent."
          : muted
            ? "Quiet hours are active, so only the urgent cue will sound."
            : "Files go in public/cues and are named in cues.json. Anything unnamed plays a synthesized tone."}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ordered.map((cue) => (
          <Button
            key={cue}
            size="sm"
            disabled={disabled}
            title={CUES[cue].when}
            aria-label={`play the ${CUES[cue].label} cue`}
            onClick={() => onPreview(cue)}
          >
            {CUES[cue].label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// Everything the interface used to say about itself, in one place instead of
// on every card. Terms on the left, one plain line each on the right.
const GUIDE: Array<[string, string]> = [
  ["Now", "What waits on you, who is working, what is ready to hand out. Everything else lives in the other tabs."],
  ["Questions", "An agent asks in its own terminal and waits there. Its card under Sessions shows a waiting mark, the question and an answer box; questions with no live terminal are listed at the foot of that card."],
  ["Ready work", "Unblocked beads per project; dispatch sends a worker, Terminal opens one by hand."],
  ["Capri card", "The meta terminal: you only, audited. It runs with no permission prompts, like the other terminals; it opens from the console with no passkey on this box; outside-repo changes are reverted or listed on close."],
  ["Capri crystal", "The voice ear's live state: green breath idle, flex listening, amber ember thinking, wave speaking. Asleep shows a wake button."],
  ["Terminals", "Every terminal you have open; the same list Now shows, not a second one."],
  ["Stack", "Installed versus used, friction versus catch, and what it costs."],
  ["Machines", "hqbox hardware, programs, jobs, automations and deploys."],
  ["Money", "Live token spend, the ledger of what moved, and committed spending. Forecasts and records never add together."],
];

export function SettingsDialog({
  open,
  settings,
  onChange,
  onClose,
  onPreview,
}: {
  open: boolean;
  settings: SettingsValue;
  onChange: (patch: Partial<SettingsValue>) => void;
  onClose: () => void;
  /** Play one cue, so a new sound file can be heard without waiting for the event. */
  onPreview?: (cue: CueName) => void;
}) {
  // A local copy of the number field, so typing "1" on the way to "15" does not clamp
  // under your fingers; it commits on blur and on Enter.
  const [idleDraft, setIdleDraft] = useState(String(settings.standbyIdleMin));
  useEffect(() => {
    setIdleDraft(String(settings.standbyIdleMin));
  }, [settings.standbyIdleMin, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const commitIdle = () => onChange({ standbyIdleMin: Number(idleDraft) });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[10vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-full max-w-lg overflow-hidden rounded-card border border-line bg-panel shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
          <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.06em] text-mute">Settings</h2>
          <span className="text-[11px] text-faint">this screen only</span>
        </div>

        <div className="px-3.5 py-1">
          <Row
            title="Standby"
            note="Dim to a watch face when nothing needs you. Never while a request is open, and never on a phone."
          >
            <Toggle on={settings.standby} onChange={(next) => onChange({ standby: next })} label="standby" />
          </Row>

          <Row
            title="Dim after"
            note={`Minutes untouched before the plate comes up. ${IDLE_MIN} to ${IDLE_MAX}.`}
          >
            <input
              className={cx(inputClass, "w-20 text-right tabular-nums")}
              type="number"
              min={IDLE_MIN}
              max={IDLE_MAX}
              step={1}
              value={idleDraft}
              disabled={!settings.standby}
              aria-label="minutes before standby"
              onChange={(e) => setIdleDraft(e.target.value)}
              onBlur={commitIdle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitIdle();
                }
              }}
            />
            <span className="text-[12px] text-mute">min</span>
          </Row>

          <Row title="Project marks" note="Draw the per-project sigil beside project names. The label never goes away.">
            <Toggle on={settings.sigils} onChange={(next) => onChange({ sigils: next })} label="project marks" />
          </Row>

          <Row title="Since you left" note="Show the ribbon counting what happened while you were away.">
            <Toggle on={settings.awayRibbon} onChange={(next) => onChange({ awayRibbon: next })} label="away ribbon" />
          </Row>

          <Row
            title="Sound"
            note="Ring for questions, failures and finished work. Off is a hard mute: even a P0 stays silent."
          >
            <Toggle on={settings.sound} onChange={(next) => onChange({ sound: next })} label="sound" />
          </Row>

          <Row
            title="Quiet hours"
            note={
              settings.quietFrom === settings.quietTo
                ? "Set both to the same hour for no quiet window. Only a P0 ever pierces quiet hours."
                : `Silent from ${hourLabel(settings.quietFrom)} to ${hourLabel(settings.quietTo)}. Only a P0 pierces it.`
            }
          >
            <HourPicker
              value={settings.quietFrom}
              disabled={!settings.sound}
              label="quiet hours start"
              onChange={(next) => onChange({ quietFrom: next })}
            />
            <span className="text-[12px] text-mute">to</span>
            <HourPicker
              value={settings.quietTo}
              disabled={!settings.sound}
              label="quiet hours end"
              onChange={(next) => onChange({ quietTo: next })}
            />
          </Row>

          {onPreview ? <CuePreview disabled={!settings.sound} muted={quietNow(settings)} onPreview={onPreview} /> : null}

          {/* The one place the console explains itself. The cards and tabs used
              to carry these lines as visible copy, which read as a tutorial;
              a production app does what it does and keeps the manual here. */}
          <details className="border-t border-line py-3">
            <summary className="cursor-pointer text-[13px] text-ink">What everything is</summary>
            <dl className="m-0 mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12px]">
              {GUIDE.map(([term, def]) => (
                <div key={term} className="contents">
                  <dt className="text-ink">{term}</dt>
                  <dd className="m-0 text-mute">{def}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-3.5 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(DEFAULTS);
              setIdleDraft(String(DEFAULTS.standbyIdleMin));
            }}
          >
            reset
          </Button>
          <Button size="sm" onClick={onClose}>
            done
          </Button>
        </div>
      </div>
    </div>
  );
}
