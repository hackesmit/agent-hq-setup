// Palette verbs: the actions Cmd-K can run, and the ones it deliberately cannot.
//
// The palette already knew every request, bead and session on screen and could only jump
// between tabs. These are the verbs, built as data so the rules are testable without a
// DOM: what appears, in what order, what command each one will fire, and which verbs are
// refused with a reason rather than quietly offered.
//
// The rule that shapes all of it: the palette may do anything ONE click in a panel can
// do, and nothing that today takes two deliberate steps. Merging and killing are two
// steps on purpose, so no fuzzy prefix here ever resolves to them.
import type { ConsoleState, ReadyBead, Request, Session } from "@shared/api";
import { modelId } from "../now/models";
import { flowPath, flowPathFor } from "./routes";

/** The three the Tab key cycles through: the current generation only. */
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
/** Any id the dispatch endpoint accepts, including the previous generation. */
export type Model = string;

/** Short name for a model id, for the chip. */
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, "-$1.$2");
}

/**
 * The model a bead should go out with: its own field, else the routing default.
 * The field is resolved against the full catalogue (now/models.ts), not the Tab
 * cycle, so an explicit previous-generation id such as claude-sonnet-5 is honoured
 * rather than silently replaced (lucy round 1, 2026-10-08).
 */
export function modelFor(bead: Pick<ReadyBead, "model" | "labels">): Model {
  const named = modelId(bead.model);
  if (named) return named;
  // routing says size up when unsure, and redteam work never goes to the small model
  return "claude-opus-5-5";
}

export type VerbKind = "jump" | "dispatch" | "answer" | "terminal" | "snooze" | "flow" | "refused";

export interface PaletteVerb {
  id: string;
  kind: VerbKind;
  label: string;
  hint: string;
  /** The command this will run, shown before it fires. Null for pure navigation. */
  cmd: string | null;
  /** A refused verb is listed so it is discoverable, and says why it is not offered. */
  refused?: string;
  /** Dispatch only: which model the chip shows, cycled with Tab. */
  model?: Model;
  /** Dispatch only, so the component can re-target the model. */
  bead?: ReadyBead;
  run?: () => void;
}

export interface VerbHandlers {
  navigate: (path: string) => void;
  dispatch: (bead: ReadyBead, model: Model) => void;
  answer: (request: Request, text: string) => void;
  openTerminal: (session: Session) => void;
  snooze: (request: Request) => void;
}

/** Requests worth offering: open, oldest and most severe first, in severity order. */
export function answerable(state: ConsoleState | null): Request[] {
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return (state?.requests ?? [])
    .filter((r) => r.state === "open")
    .slice()
    .sort((a, b) => {
      const s = (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
      return s !== 0 ? s : a.createdAt.localeCompare(b.createdAt);
    });
}

/** True when the typed text is an answer rather than a search. */
export function isAnswerQuery(query: string): boolean {
  return query.trimStart().startsWith(">");
}

/** The answer text, with the marker and surrounding space removed. */
export function answerText(query: string): string {
  return query.trimStart().replace(/^>\s?/, "").trim();
}

/**
 * The verbs for the current state and query. The component supplies the handlers, so
 * this stays a pure description of what the palette offers.
 */
export function verbsFor(
  state: ConsoleState | null,
  query: string,
  handlers: VerbHandlers,
  modelOverrides: Record<string, Model> = {},
): PaletteVerb[] {
  const verbs: PaletteVerb[] = [];

  // Answer composer: while the query starts with ">", the palette is a text box aimed at
  // one request, and nothing else is offered. Ambiguity here would send a worker the
  // wrong answer, so the target is named in the label rather than guessed at silently.
  if (isAnswerQuery(query)) {
    const target = answerable(state)[0];
    const text = answerText(query);
    if (!target) {
      verbs.push({
        id: "answer:none",
        kind: "refused",
        label: "Nothing is waiting on you",
        hint: "no open request",
        cmd: null,
        refused: "no open request to answer",
      });
      return verbs;
    }
    verbs.push({
      id: `answer:${target.id}`,
      kind: "answer",
      label: text ? `Answer ${target.id}: ${text}` : `Answer ${target.id}`,
      hint: text ? `${target.severity}, ${target.rig ?? "hq"}, Enter sends` : "type the answer after the arrow",
      cmd: text ? `ctl.sh answer ${target.id} ${JSON.stringify(text)}` : null,
      run: text ? () => handlers.answer(target, text) : undefined,
    });
    return verbs;
  }

  for (const bead of state?.ready ?? []) {
    const model = modelOverrides[bead.id] ?? modelFor(bead);
    const redteam = bead.labels.includes("redteam");
    verbs.push({
      id: `dispatch:${bead.id}`,
      kind: "dispatch",
      label: `Dispatch ${bead.id} to ${bead.rig}`,
      hint: [`ready`, `P${bead.priority}`, redteam ? "redteam" : null].filter(Boolean).join(", "),
      cmd: `ctl.sh dispatch ${bead.id} --rig ${bead.rig} --model ${model}`,
      model,
      bead,
      run: () => handlers.dispatch(bead, model),
    });
  }

  for (const request of answerable(state)) {
    verbs.push({
      id: `snooze:${request.id}`,
      kind: "snooze",
      label: `Snooze ${request.id} until tomorrow`,
      hint: `${request.severity}, ${request.rig ?? "hq"}`,
      cmd: `ctl.sh req-snooze ${request.id} tomorrow`,
      run: () => handlers.snooze(request),
    });
  }

  for (const session of state?.sessions ?? []) {
    if (!session.attachable) continue;
    verbs.push({
      id: `terminal:${session.id}`,
      kind: "terminal",
      label: `Open terminal ${session.id}`,
      hint: `${session.rig ?? "no rig"}, ${session.state}`,
      cmd: null,
      run: () => handlers.openTerminal(session),
    });
  }

  verbs.push(...flowVerbs(state, query, handlers));

  // Listed, never offered. Discoverable is good; reachable by a three letter prefix is
  // not, for the two verbs that merge work into main or end a running session.
  const finishable = (state?.sessions ?? []).find((s) => s.state === "finishable");
  if (finishable) {
    verbs.push({
      id: `refused:finish:${finishable.id}`,
      kind: "refused",
      label: `finish ${finishable.id} --confirm`,
      hint: "use the Finish button on the session row",
      cmd: null,
      refused: "merging is two deliberate steps, and this is one",
    });
  }
  const live = (state?.sessions ?? []).find((s) => s.state === "running" || s.state === "waiting");
  if (live) {
    verbs.push({
      id: `refused:kill:${live.id}`,
      kind: "refused",
      label: `kill ${live.id}`,
      hint: "use the Kill button on the session row",
      cmd: null,
      refused: "ending a session is two deliberate steps, and this is one",
    });
  }

  return verbs;
}

/**
 * "flow <project>" and "flow <bead>": open a flow chart (bead hq-c4pl0.3). Every
 * project, every bead on screen (sessions, requests, ready work), and a bead id
 * typed after "flow " that is not on screen, resolved by its prefix.
 */
export function flowVerbs(state: ConsoleState | null, query: string, handlers: VerbHandlers): PaletteVerb[] {
  const projectIds = (state?.projects ?? []).map((p) => p.id);
  const verbs: PaletteVerb[] = [];
  for (const id of projectIds) {
    const path = flowPath(id);
    verbs.push({ id: `flow:${id}`, kind: "flow", label: `flow ${id}`, hint: "project chart", cmd: null, run: () => handlers.navigate(path) });
  }
  const seen = new Set<string>();
  const beadVerb = (rig: string | null, bead: string | null) => {
    if (!bead || seen.has(bead)) return;
    const path = flowPathFor(projectIds, rig, bead);
    if (!path) return;
    seen.add(bead);
    verbs.push({
      id: `flow:${bead}`,
      kind: "flow",
      label: `flow ${bead}`,
      hint: `${rig ?? path.split("/")[2]} chart, at this bead`,
      cmd: null,
      run: () => handlers.navigate(path),
    });
  };
  for (const s of state?.sessions ?? []) beadVerb(s.rig, s.bead);
  for (const r of state?.requests ?? []) if (r.state === "open") beadVerb(r.rig, r.bead);
  for (const b of state?.ready ?? []) beadVerb(b.rig, b.id);
  const typed = query.trim().match(/^flow\s+([a-z]{1,6}-[A-Za-z0-9]{1,16}(?:\.[0-9]{1,4})*)$/)?.[1];
  if (typed && !projectIds.includes(typed)) beadVerb(null, typed);
  return verbs;
}

/** Match on the label and the hint, the same rule the jump list already used. */
export function filterVerbs(verbs: readonly PaletteVerb[], query: string): PaletteVerb[] {
  const needle = query.trim().toLowerCase();
  if (!needle || isAnswerQuery(query)) return [...verbs];
  return verbs.filter((v) => v.label.toLowerCase().includes(needle) || v.hint.toLowerCase().includes(needle));
}

/** Tab on a dispatch row moves to the next model in the routing order. */
export function nextModel(current: Model): Model {
  // a previous-generation id is not in the cycle: Tab moves it onto the current Opus
  const i = MODELS.indexOf(current as (typeof MODELS)[number]);
  return MODELS[(i + 1) % MODELS.length];
}
