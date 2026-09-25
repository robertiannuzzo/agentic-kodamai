import { Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DemoRole, RequisitionCase, RequisitionFields } from "../../../packages/contracts/src/index";
import { createDraft, listRequisitions, type DemoIdentity } from "./api";
import { CandidateWorkspace } from "./candidate";
import { readPreference, reference, writePreference, type DisplayCurrency, type Theme } from "./format";
import { describeError } from "./messages";
import { FieldForm, RequisitionView } from "./requisition";
import { Toasts, Topbar, useToasts } from "./shell";
import { displayStage, queueFor, stageLabels, stageTones } from "./stages";

const emptyFields: RequisitionFields = {
  role: "",
  department: "",
  headcount: 1,
  budgetMinor: 10000000,
  justification: ""
};

const defaultCandidate = "candidate@example.test";

export function App() {
  const [role, setRole] = useState<DemoRole>("requester");
  const [candidateEmail, setCandidateEmail] = useState(defaultCandidate);
  const [currency, setCurrency] = useState<DisplayCurrency>(() =>
    readPreference("kodamai.displayCurrency", ["GBP", "USD"] as const, "GBP")
  );
  const [theme, setTheme] = useState<Theme>(() => readPreference("kodamai.theme", ["dark", "light"] as const, "dark"));
  const identity = useMemo<DemoIdentity>(
    () => ({
      role,
      actor: role === "candidate" ? candidateEmail : `${role}@kodamai.test`,
      tenantId: "demo"
    }),
    [role, candidateEmail]
  );
  const [rows, setRows] = useState<RequisitionCase[]>([]);
  const [selectedReference, setSelectedReference] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { toasts, notify, dismiss } = useToasts();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const selected = rows.find(({ reference: ref }) => ref === selectedReference) ?? null;
  const matches = (row: RequisitionCase): boolean => {
    const needle = query.trim().toLowerCase();
    return (
      needle === "" ||
      row.role.toLowerCase().includes(needle) ||
      row.department.toLowerCase().includes(needle) ||
      reference(row.reference).toLowerCase().includes(needle)
    );
  };
  const inbox = queueFor(role, identity.actor, rows).filter(matches);
  const others = rows.filter((row) => !inbox.includes(row) && matches(row));
  const queueTitle = role === "approver" ? "Awaiting your review" : "Ready to advertise";
  const queueEmpty =
    role === "approver" ? "Nothing is waiting for your review." : "No approved requisitions are waiting for an advert.";

  // Only the latest request may update state: a slower response for an earlier
  // role must not overwrite what the current role should see.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (identity.role === "candidate") {
      setRows([]);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const result = await listRequisitions(identity);
      if (current !== generation.current) return;
      setRows(result);
      const waiting = queueFor(identity.role, identity.actor, result)[0];
      setSelectedReference((current) =>
        result.some(({ reference: ref }) => ref === current) ? current : (waiting ?? result[0])?.reference ?? null
      );
    } catch (failure) {
      if (current !== generation.current) return;
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [identity]);

  useEffect(() => {
    // Requisitions are identity-scoped: drop the previous role's rows at once.
    setRows([]);
    setLoading(true);
    void load();
  }, [load]);

  function accept(row: RequisitionCase): void {
    setRows((current) => [row, ...current.filter(({ reference: ref }) => ref !== row.reference)]);
    setSelectedReference(row.reference);
    setCreating(false);
  }

  async function perform(operation: () => Promise<RequisitionCase>, message: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      accept(await operation());
      notify(message);
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      setBusy(false);
    }
  }

  function renderRow(row: RequisitionCase) {
    const stage = displayStage(row);
    return (
      <button
        className={row.reference === selectedReference && !creating ? "req-row selected" : "req-row"}
        key={row.reference}
        onClick={() => {
          setSelectedReference(row.reference);
          setCreating(false);
        }}
      >
        <span className={`dot ${stageTones[stage]}`} aria-hidden="true" />
        <span className="req-row-text">
          <strong>{row.role}</strong>
          <small>
            {reference(row.reference)} · {stageLabels[stage]}
          </small>
        </span>
      </button>
    );
  }

  return (
    <div className="app-shell">
      <Topbar
        role={role}
        onRole={(next) => {
          setRole(next);
          setCreating(false);
          setError(null);
        }}
        candidateEmail={candidateEmail}
        onCandidateEmail={(email) => setCandidateEmail(email === "" ? defaultCandidate : email)}
        currency={currency}
        onCurrency={(next) => {
          setCurrency(next);
          writePreference("kodamai.displayCurrency", next);
        }}
        theme={theme}
        onTheme={(next) => {
          setTheme(next);
          writePreference("kodamai.theme", next);
        }}
      />

      {role === "candidate" ? (
        <CandidateWorkspace identity={identity} describeError={describeError} onIdentity={setCandidateEmail} />
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-heading">
              <div>
                <p className="eyebrow">Hiring</p>
                <h1>Requisitions</h1>
              </div>
              {role === "requester" ? (
                <button className="icon-button filled" onClick={() => setCreating(true)} aria-label="New requisition">
                  <Plus size={18} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <label className="search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Search requisitions"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {loading ? (
              <div className="skeleton-list" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {!loading && rows.length === 0 ? <p className="empty">No requisitions yet.</p> : null}
            {role !== "requester" && !loading ? (
              <>
                <h2 className="list-heading">
                  {queueTitle} <span className="count">{inbox.length}</span>
                </h2>
                {inbox.length === 0 ? <p className="empty compact">{queueEmpty}</p> : null}
                <nav className="req-list" aria-label={queueTitle}>
                  {inbox.map(renderRow)}
                </nav>
              </>
            ) : null}
            {!loading && others.length > 0 ? (
              <h2 className="list-heading">
                {role === "requester" ? "Your requisitions" : "All requisitions"}{" "}
                <span className="count muted">{others.length}</span>
              </h2>
            ) : null}
            <nav className="req-list" aria-label={role === "requester" ? "Your requisitions" : "All requisitions"}>
              {others.map(renderRow)}
            </nav>
          </aside>

          <main className="main">
            {error === null ? null : (
              <div className="banner" role="alert">
                <span>{error}</span>
                <button className="button small" onClick={() => void load()}>
                  Reload
                </button>
              </div>
            )}

            {creating ? (
              <section className="panel create-panel">
                <p className="eyebrow">New requisition</p>
                <h1 className="display">Create a hiring request</h1>
                <p className="lede">Save a draft now and submit it when it's ready for approval.</p>
                <FieldForm
                  action="Save draft"
                  busy={busy}
                  currency={currency}
                  initial={emptyFields}
                  onCancel={() => setCreating(false)}
                  onSubmit={(value) => perform(() => createDraft(identity, value), "Draft saved")}
                />
              </section>
            ) : selected === null ? (
              <section className="welcome">
                <p className="eyebrow">
                  <span className="pulse" aria-hidden="true" /> Verified recruitment
                </p>
                <h1 className="display">
                  Every hire, <em>traceable</em>.
                </h1>
                <p className="lede">
                  Request a new hire, get it approved, advertise the role, and choose who to hire.
                </p>
                {role === "requester" ? (
                  <button className="button primary" onClick={() => setCreating(true)}>
                    Create first requisition
                  </button>
                ) : (
                  <p className="muted">Switch to Requester to raise the first requisition.</p>
                )}
              </section>
            ) : (
              <RequisitionView
                key={`${selected.reference}:${displayStage(selected)}:${role}`}
                row={selected}
                role={role}
                identity={identity}
                currency={currency}
                busy={busy}
                perform={perform}
                onRefresh={load}
                notify={notify}
              />
            )}
          </main>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
