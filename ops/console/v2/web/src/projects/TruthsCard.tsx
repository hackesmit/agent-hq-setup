// Truths editor. The console is the only writer of ops/projects/<id>/truths.json, so this
// card carries the whole contract: optimistic revision, a 409 that reloads rather than
// overwrites, and the amber "unconfirmed" state that also drives the decide cards in Now.

import { useEffect, useReducer, useState } from "react";
import type { TruthEntry, TruthKind } from "@shared/api";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip, inputClass, Note } from "../ui/primitives";
import { fmtAge } from "../ui/format";
import { errorText, isConflict, projectsApi } from "./api";
import { Markdown } from "./Markdown";
import {
  EMPTY_TRUTHS,
  KIND_LABELS,
  TRUTH_KINDS,
  groupByKind,
  savePayload,
  truthsMarkdown,
  truthsReducer,
  unconfirmed,
} from "./truths";
import { useAsync } from "./useAsync";

function KindChip({ kind }: { kind: TruthKind }) {
  return (
    <Chip tone={kind === "constraint" ? "warn" : kind === "assumption" ? "accent" : "mute"}>{KIND_LABELS[kind]}</Chip>
  );
}

function EntryRow({
  entry,
  onEdit,
  onConfirm,
  onDelete,
}: {
  entry: TruthEntry;
  onEdit: (text: string) => void;
  onConfirm: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  useEffect(() => {
    if (!editing) setDraft(entry.text);
  }, [entry.text, editing]);

  return (
    <div className="flex items-start gap-2 border-b border-line py-1.5 last:border-b-0">
      <KindChip kind={entry.kind} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            className={`${inputClass} min-h-[54px]`}
            value={draft}
            aria-label={`Edit ${entry.id}`}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <span className="text-[13px] leading-[1.5]">{entry.text}</span>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          <span className="font-mono">{entry.id}</span>
          {entry.source ? <span>source: {entry.source}</span> : null}
          <span>added {fmtAge(entry.added)} ago</span>
          {!entry.confirmed ? <Chip tone="warn">unconfirmed</Chip> : null}
        </div>
      </div>
      <ButtonRow>
        {editing ? (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onEdit(draft);
                setEditing(false);
              }}
            >
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {entry.confirmed ? null : (
              <Button size="sm" variant="primary" onClick={onConfirm}>
                Confirm
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete} aria-label={`Delete ${entry.id}`}>
              Delete
            </Button>
          </>
        )}
      </ButtonRow>
    </div>
  );
}

function AddForm({ onAdd }: { onAdd: (kind: TruthKind, text: string, source: string) => void }) {
  const [kind, setKind] = useState<TruthKind>("truth");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");

  return (
    <form
      className="mt-2 grid gap-1.5 rounded-sub border border-line bg-panel2/40 px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        onAdd(kind, text, source);
        setText("");
        setSource("");
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {TRUTH_KINDS.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === kind ? "primary" : "default"}
            onClick={() => setKind(option)}
          >
            {KIND_LABELS[option]}
          </Button>
        ))}
      </div>
      <textarea
        className={`${inputClass} min-h-[54px]`}
        placeholder="One clear statement. An assumption starts unconfirmed."
        aria-label="New truth text"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        <input
          className={`${inputClass} flex-1`}
          placeholder="source (bead id, person, doc) - optional"
          aria-label="Source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!text.trim()}>
          Add
        </Button>
      </div>
    </form>
  );
}

export function TruthsCard({ project }: { project: string }) {
  const [state, dispatch] = useReducer(truthsReducer, EMPTY_TRUTHS);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState(false);
  const { data, error, loading, reload } = useAsync(
    (signal) => projectsApi.truths(project, signal),
    `${project}:truths`,
  );

  useEffect(() => {
    if (data) dispatch({ t: "loaded", doc: data });
  }, [data]);

  async function save(): Promise<void> {
    dispatch({ t: "saving" });
    try {
      const payload = savePayload(state);
      const doc = await projectsApi.saveTruths(project, payload.rev, payload.entries);
      dispatch({ t: "saved", doc });
    } catch (cause) {
      if (isConflict(cause)) {
        try {
          const fresh = await projectsApi.truths(project);
          dispatch({ t: "conflict", doc: fresh });
        } catch (reloadCause) {
          dispatch({ t: "error", message: errorText(reloadCause) });
        }
        return;
      }
      dispatch({ t: "error", message: errorText(cause) });
    }
  }

  const groups = groupByKind(state.entries);
  const open = unconfirmed(state.entries);

  return (
    <Card>
      <CardHead
        title="Truths"
        chip={<Chip tone="mute">ops/projects/{project}/truths.json</Chip>}
        actions={
          <ButtonRow>
            {open.length > 0 ? <Chip tone="warn">{open.length} unconfirmed</Chip> : null}
            <Button size="sm" onClick={() => setPreview((value) => !value)}>
              {preview ? "Entries" : "Mirror"}
            </Button>
            <Button size="sm" onClick={() => setAdding((value) => !value)}>
              {adding ? "Cancel" : "Add truth"}
            </Button>
            <Button size="sm" variant="primary" disabled={!state.dirty || state.saving} onClick={() => void save()}>
              {state.saving ? "Saving" : "Save"}
            </Button>
          </ButtonRow>
        }
      />
      <CardBody>
        {loading && !state.loaded ? <p className="m-0 text-[12px] text-mute">Loading truths.</p> : null}
        {error && !state.loaded ? (
          <p className="m-0 text-[12px] text-bad">
            No truths yet, or the file could not be read. {errorText(error)}{" "}
            <Button size="sm" variant="ghost" onClick={reload}>
              Retry
            </Button>
          </p>
        ) : null}

        {state.conflict ? (
          <div className="mb-2 rounded-sub border border-warn/50 bg-warn/10 px-2.5 py-2 text-[12px]">
            <b>Changed elsewhere.</b> The file moved to revision {state.rev} while you were editing. The list below is
            the server copy.
            <ButtonRow className="mt-1.5">
              <Button size="sm" variant="primary" onClick={() => dispatch({ t: "reapply" })}>
                Reapply my edit
              </Button>
              <Button size="sm" onClick={() => dispatch({ t: "discard" })}>
                Keep the server copy
              </Button>
            </ButtonRow>
          </div>
        ) : null}

        {state.error && !state.conflict ? (
          <p className="mb-2 mt-0 text-[12px] text-bad">{state.error}</p>
        ) : null}

        {preview ? (
          <div className="hq-scroll max-h-[50vh] overflow-y-auto rounded-sub border border-line bg-panel2/40 px-2.5 py-1">
            <Markdown source={truthsMarkdown(project, state.entries)} />
          </div>
        ) : (
          <>
            {groups.length === 0 && state.loaded ? (
              <p className="m-0 text-[12px] text-mute">
                Nothing stated yet. Every worker on this project is guessing until you add the first truth.
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.kind} className="mb-2">
                {group.entries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    onEdit={(text) => dispatch({ t: "edit", id: entry.id, text })}
                    onConfirm={() => dispatch({ t: "confirm", id: entry.id })}
                    onDelete={() => dispatch({ t: "delete", id: entry.id })}
                  />
                ))}
              </div>
            ))}
            {adding ? (
              <AddForm
                onAdd={(kind, text, source) =>
                  dispatch({ t: "add", kind, text, source, at: new Date().toISOString() })
                }
              />
            ) : null}
          </>
        )}

        <Note>
          Revision {state.rev}
          {state.updatedAt ? `, written ${fmtAge(state.updatedAt)} ago` : ""}
        </Note>
      </CardBody>
    </Card>
  );
}
