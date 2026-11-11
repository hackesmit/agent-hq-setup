// What each client is worth, and what each has cost in agent effort.
//
// The client-to-project mapping is not configured anywhere. It emerges from the
// ledger: tagging a payment with both a client and a project is what teaches the
// console the two belong together. That means there is no second file to keep in
// step with reality, and a client with nothing tagged honestly reports nothing
// rather than a plausible-looking zero.
//
// The one number this card refuses to invent is a split. A project worked for two
// clients counts its tokens for both, and says so, because halving it would be a
// figure nobody measured.
import type { MoneyClient, MoneyReport } from "@shared/api";
import { Card, CardBody, CardHead, Chip, RigSigil, cx } from "../ui/primitives";
import { RunningNet } from "./Charts";
import { clientMonthlyFlows, costPerMillion, fmtCents, fmtTokens, runningNet } from "./model";

function ClientRow({ client, shared, report }: { client: MoneyClient; shared: Set<string>; report: MoneyReport | null }) {
  const net = client.money.map((m) => ({ ...m, netCents: m.inCents - m.outCents }));
  // the owner: "add a cumulative net line to the clients card too". The same
  // running line as the flows card, from this client's own rows.
  const months = clientMonthlyFlows(report, client.client);
  return (
    <div className="hq-arrive border-b border-line px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold text-ink">{client.client}</span>
        {net.map((m) => (
          <span key={m.currency} className={cx("tabular-nums text-[13px]", m.netCents >= 0 ? "text-ok" : "text-bad")}>
            {fmtCents(m.netCents, m.currency)}
          </span>
        ))}
        {client.commitmentCount > 0 ? (
          <Chip tone="mute">
            {client.commitmentCount} repeating
          </Chip>
        ) : null}
        <span className="ml-auto text-[11px] text-mute">
          {client.tokens > 0 ? (
            <>
              <span className="tabular-nums text-ink">{fmtTokens(client.tokens)}</span> tokens,{" "}
              <span className="tabular-nums text-ink">{client.sessions}</span> sessions
            </>
          ) : (
            "no project tagged, so effort is unknown"
          )}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mute">
        {client.projects.length > 0 ? (
          client.projects.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <RigSigil id={p} size={12} />
              {p}
              {shared.has(p) ? (
                <span title="worked for more than one client, so its effort counts for each">shared</span>
              ) : null}
            </span>
          ))
        ) : (
          <span>Tag a payment with a project to attribute effort.</span>
        )}
        {net.map((m) => {
          const per = costPerMillion(client, m.currency);
          return per === null ? null : (
            <span key={`v-${m.currency}`} className="ml-auto tabular-nums">
              {fmtCents(per, m.currency)} per million tokens
            </span>
          );
        })}
      </div>

      <div className="mt-2">
        {months.kind === "ok" ? (
          <RunningNet points={runningNet(months.rows, 6)} currency={months.currency} compact />
        ) : (
          <p className="m-0 text-[11px] text-mute">
            {months.kind === "mixed"
              ? "Two currencies and no rate yet, so no single line to draw."
              : "No dated rows in view for this client yet."}
          </p>
        )}
      </div>
    </div>
  );
}

export function Clients({ money }: { money: MoneyReport | null }) {
  const clients = money?.clients ?? [];
  // A project claimed by more than one client is labelled rather than divided.
  const counts = new Map<string, number>();
  for (const c of clients) for (const p of c.projects) counts.set(p, (counts.get(p) ?? 0) + 1);
  const shared = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p));

  return (
    <Card>
      <CardHead title="Clients" chip={<Chip tone="mute">{clients.length}</Chip>} />
      <CardBody className="px-0 pb-0 pt-0">
        {clients.length === 0 ? (
          <p className="m-0 px-3.5 py-6 text-center text-[13px] text-mute">
            No client tagged yet. Put a client on a payment and this becomes what they are worth against what their
            projects have cost in agent time.
          </p>
        ) : (
          clients.map((c) => <ClientRow key={c.client} client={c} shared={shared} report={money} />)
        )}
      </CardBody>
    </Card>
  );
}
