// Board: every project as a checklist. Where it stands, what moves next, what is
// done. The Projects grid answers "how far"; this answers "what, exactly", so a
// morning read of twelve projects is one page and no clicks.

import type { BoardItem, BoardProject, BoardReport } from "@shared/api";
import { navigate } from "../app/router";
import { projectPath } from "../app/routes";
import { groupBoard, markOf, moreLabel, stateLine, type Mark } from "../board/board";
import { ATTENTION_CHIP } from "../projects/overview";
import { Card, CardBody, Chip, PageHeader, ProgressBar, cx } from "../ui/primitives";
import { fmtAge } from "../ui/format";

const MARK_CLASS: Record<Mark, string> = {
  done: "border-ok bg-ok",
  moving: "border-accent bg-accent/40",
  blocked: "border-bad bg-bad/40",
  todo: "border-line bg-transparent",
};

const MARK_TITLE: Record<Mark, string> = {
  done: "closed",
  moving: "in progress",
  blocked: "blocked",
  todo: "open",
};

function Box({ mark }: { mark: Mark }) {
  return (
    <span
      role="img"
      aria-label={MARK_TITLE[mark]}
      title={MARK_TITLE[mark]}
      className={cx("mt-[3px] inline-block h-[10px] w-[10px] shrink-0 rounded-[2px] border", MARK_CLASS[mark])}
    />
  );
}

function Row({ item }: { item: BoardItem }) {
  const mark = markOf(item);
  return (
    <li className="flex items-start gap-2 text-[12px] leading-[18px]">
      <Box mark={mark} />
      <span className={cx("min-w-0 flex-1", mark === "done" ? "text-mute" : "text-ink")}>
        <span className="mr-1.5 font-mono text-[11px] text-faint">{item.id}</span>
        {item.title}
      </span>
    </li>
  );
}

function List({ label, items, total, noun }: { label: string; items: BoardItem[]; total: number; noun: string }) {
  if (total === 0) return null;
  const more = moreLabel(items.length, total, noun);
  return (
    <div className="mt-2.5">
      <small className="block text-[10px] uppercase tracking-[0.05em] text-mute">
        {label} {total}
      </small>
      <ul className="m-0 mt-1 list-none p-0">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
      {more ? <span className="mt-0.5 block text-[11px] text-faint">{more}</span> : null}
    </div>
  );
}

function ProjectRow({ p }: { p: BoardProject }) {
  const chip = ATTENTION_CHIP[p.attention];
  const href = projectPath(p.id);
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
            <a
              href={href}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate(href);
              }}
              className="text-[15px] font-semibold text-ink no-underline hover:text-accent"
            >
              {p.name}
            </a>
            {p.client ? <span className="text-[11px] uppercase tracking-[0.05em] text-mute">{p.client}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {p.completion !== null ? <span className="font-mono text-[11px] text-mute">{Math.round(p.completion * 100)}%</span> : null}
            <Chip tone={p.error ? "warn" : chip.tone}>{p.error ? "degraded" : chip.label}</Chip>
          </span>
        </div>

        <div className="mt-1 text-[12px] text-mute">
          <span className="text-ink">{stateLine(p)}</span>
          {p.lastCommit ? (
            <span title={p.lastCommit.subject}>
              {" "}
              merge {fmtAge(p.lastCommit.at)}: {p.lastCommit.subject.length > 72 ? `${p.lastCommit.subject.slice(0, 72)}...` : p.lastCommit.subject}
            </span>
          ) : null}
        </div>

        <div className="mt-2 rounded-sub bg-panel2 px-2.5 py-1.5 text-[12px]">
          {p.next ? (
            <>
              <b className="mr-1.5 text-[10px] uppercase tracking-[0.05em] text-mute">{p.next.status === "in_progress" ? "now" : "next"}</b>
              <span className="mr-1.5 font-mono text-[11px] text-faint">{p.next.id}</span>
              <span className="text-ink">{p.next.title}</span>
            </>
          ) : (
            <span className="text-mute">{p.todoTotal > 0 ? "nothing ready: every open bead is blocked or waiting" : "nothing queued"}</span>
          )}
        </div>

        {p.epic ? (
          <div className="mt-2 flex items-center gap-2 text-[12px]" title={p.epic.id}>
            <span className="min-w-0 flex-1 truncate text-ink">{p.epic.title}</span>
            <ProgressBar value={p.epic.total > 0 ? p.epic.done / p.epic.total : 0} width={80} />
            <span className="shrink-0 font-mono text-[11px] text-mute">
              {p.epic.done}/{p.epic.total}
            </span>
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-faint">no epic in motion; done is the last two weeks, to do is everything open</div>
        )}

        {p.blocked.length > 0 ? <List label="Blocked" items={p.blocked} total={p.blocked.length} noun="blocked" /> : null}
        <List label="To do" items={p.todo} total={p.todoTotal} noun="open" />
        <List label="Done" items={p.done} total={p.doneTotal} noun="done" />
        {p.error ? <p className="mb-0 mt-2 text-[11px] text-warn">{p.error}</p> : null}
      </CardBody>
    </Card>
  );
}

function Band({ title, rows }: { title: string; rows: BoardProject[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-4 first:mt-0">
      <h2 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-mute">
        {title} <span className="font-mono text-faint">{rows.length}</span>
      </h2>
      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {rows.map((p) => (
          <ProjectRow key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}

export function BoardTab({ board }: { board: BoardReport | null }) {
  const groups = groupBoard(board?.projects ?? []);
  return (
    <>
      <PageHeader
        title="Board"
        actions={board ? <span className="text-[11px] text-mute">as of {fmtAge(board.generatedAt)}</span> : null}
      />
      {!board ? <p className="m-0 text-[13px] text-mute">The board collector has not reported yet.</p> : null}
      <Band title="Work" rows={groups.work} />
      <Band title="Personal" rows={groups.personal} />
      <Band title="Paused" rows={groups.paused} />
    </>
  );
}
