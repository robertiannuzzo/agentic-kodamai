import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  DemoRole,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision
} from "../../../packages/contracts/src/index";
import {
  createDraft,
  listRequisitions,
  resubmitRequisition,
  reviewRequisition,
  submitDraft,
  updateDraft,
  type DemoIdentity
} from "./api";

const emptyFields: RequisitionFields = {
  role: "",
  department: "",
  headcount: 1,
  budgetMinor: 10000000,
  justification: ""
};

const stageLabels: Record<RequisitionCase["stage"], string> = {
  draft: "Draft",
  "awaiting-review": "Awaiting review",
  approved: "Approved",
  "needs-rework": "Changes requested",
  declined: "Declined",
  advertising: "Advertising"
};

function formatMoney(minor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(minor / 100);
}

function formatTime(tick: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(tick));
}

function FieldForm({
  initial,
  action,
  busy,
  onSubmit,
  onCancel
}: {
  initial: RequisitionFields;
  action: string;
  busy: boolean;
  onSubmit(fields: RequisitionFields): Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [budget, setBudget] = useState(String(initial.budgetMinor / 100));

  useEffect(() => {
    setValue(initial);
    setBudget(String(initial.budgetMinor / 100));
  }, [initial]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onSubmit({ ...value, budgetMinor: Math.round(Number(budget) * 100) });
  }

  return (
    <form className="field-form" onSubmit={(event) => void submit(event)}>
      <div className="form-grid">
        <label>
          Role title
          <input
            required
            value={value.role}
            onChange={(event) => setValue({ ...value, role: event.target.value })}
            placeholder="Senior Software Engineer"
          />
        </label>
        <label>
          Department
          <input
            required
            value={value.department}
            onChange={(event) => setValue({ ...value, department: event.target.value })}
            placeholder="Engineering"
          />
        </label>
        <label>
          Headcount
          <input
            required
            min="1"
            type="number"
            value={value.headcount}
            onChange={(event) => setValue({ ...value, headcount: Number(event.target.value) })}
          />
        </label>
        <label>
          Annual budget (USD)
          <input
            required
            min="1"
            step="1"
            type="number"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
      </div>
      <label>
        Business justification
        <textarea
          required
          rows={5}
          value={value.justification}
          onChange={(event) => setValue({ ...value, justification: event.target.value })}
          placeholder="Why does the organization need this role?"
        />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Saving…" : action}
        </button>
        {onCancel === undefined ? null : (
          <button disabled={busy} type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function AuditTimeline({ row }: { row: RequisitionCase }) {
  return (
    <section className="audit-section" aria-labelledby="audit-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Evidence</p>
          <h2 id="audit-title">Audit timeline</h2>
        </div>
        <span>{row.history.length} recorded events</span>
      </div>
      <ol className="timeline">
        {[...row.history].reverse().map((entry, index) => (
          <li key={`${entry.tick}-${entry.event}-${index}`}>
            <span className="timeline-marker" aria-hidden="true" />
            <div>
              <strong>{entry.event.replaceAll("-", " ")}</strong>
              <p>{entry.detail}</p>
              <small>
                {entry.actor} · revision {entry.revision} · {formatTime(entry.tick)}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewPanel({
  busy,
  onReview
}: {
  busy: boolean;
  onReview(decision: ReviewDecision, reason: string): Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <section className="review-panel">
      <p className="eyebrow">Approver action</p>
      <h2>Review this requisition</h2>
      <label>
        Reason for declining or requesting changes
        <textarea
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Required for decline or changes"
        />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void onReview("approve", "")}>
          Approve
        </button>
        <button disabled={busy} onClick={() => void onReview("hold", reason)}>
          Request changes
        </button>
        <button className="danger" disabled={busy} onClick={() => void onReview("decline", reason)}>
          Decline
        </button>
      </div>
    </section>
  );
}

export function App() {
  const [role, setRole] = useState<DemoRole>("requester");
  const identity = useMemo<DemoIdentity>(
    () => ({ role, actor: role === "requester" ? "requester@kodamai.test" : "approver@kodamai.test" }),
    [role]
  );
  const [rows, setRows] = useState<RequisitionCase[]>([]);
  const [selectedReference, setSelectedReference] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selected = rows.find(({ reference }) => reference === selectedReference) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRequisitions(identity);
      setRows(result);
      setSelectedReference((current) => current ?? result[0]?.reference ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to load requisitions");
    } finally {
      setLoading(false);
    }
  }, [identity]);

  useEffect(() => void load(), [load]);

  function accept(row: RequisitionCase): void {
    setRows((current) => [row, ...current.filter(({ reference }) => reference !== row.reference)]);
    setSelectedReference(row.reference);
    setCreating(false);
  }

  async function perform(operation: () => Promise<RequisitionCase>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      accept(await operation());
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Action failed";
      setError(message === "stale-version" ? "This requisition changed. Reload and try again." : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <div>
            <strong>Agentic Kodamai</strong>
            <span>Recruitment workspace</span>
          </div>
        </div>
        <div className="role-switch" aria-label="Demo role">
          <span>Viewing as</span>
          <button className={role === "requester" ? "active" : ""} onClick={() => setRole("requester")}>
            Requester
          </button>
          <button className={role === "approver" ? "active" : ""} onClick={() => setRole("approver")}>
            Approver
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">Hiring</p>
              <h1>Requisitions</h1>
            </div>
            {role === "requester" ? (
              <button className="new-button" onClick={() => setCreating(true)} aria-label="New requisition">
                +
              </button>
            ) : null}
          </div>
          {loading ? <p className="empty">Loading…</p> : null}
          {!loading && rows.length === 0 ? <p className="empty">No requisitions yet.</p> : null}
          <nav className="requisition-list" aria-label="Requisitions">
            {rows.map((row) => (
              <button
                className={row.reference === selectedReference && !creating ? "selected" : ""}
                key={row.reference}
                onClick={() => {
                  setSelectedReference(row.reference);
                  setCreating(false);
                }}
              >
                <span className={`status-dot ${row.stage}`} />
                <span>
                  <strong>{row.role}</strong>
                  <small>
                    REQ-{String(row.reference).padStart(4, "0")} · {stageLabels[row.stage]}
                  </small>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="main-panel">
          {error === null ? null : (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => void load()}>Reload</button>
            </div>
          )}

          {creating ? (
            <section className="content-card">
              <p className="eyebrow">New requisition</p>
              <h1>Create a hiring request</h1>
              <p className="lede">Save a draft now. Submission creates the evidence required for review.</p>
              <FieldForm
                action="Save draft"
                busy={busy}
                initial={emptyFields}
                onCancel={() => setCreating(false)}
                onSubmit={(value) => perform(() => createDraft(identity, value))}
              />
            </section>
          ) : selected === null ? (
            <section className="welcome">
              <p className="eyebrow">Typed recruitment</p>
              <h1>Begin with a requisition</h1>
              <p>Create a draft, submit it for review, and watch every transition retain its evidence.</p>
              {role === "requester" ? (
                <button className="primary" onClick={() => setCreating(true)}>
                  Create first requisition
                </button>
              ) : (
                <p>Switch to Requester to create the first requisition.</p>
              )}
            </section>
          ) : (
            <>
              <section className="content-card requisition-header">
                <div className="title-row">
                  <div>
                    <p className="eyebrow">REQ-{String(selected.reference).padStart(4, "0")}</p>
                    <h1>{selected.role}</h1>
                  </div>
                  <span className={`status-badge ${selected.stage}`}>{stageLabels[selected.stage]}</span>
                </div>
                <div className="facts">
                  <div>
                    <span>Department</span>
                    <strong>{selected.department}</strong>
                  </div>
                  <div>
                    <span>Headcount</span>
                    <strong>{selected.headcount}</strong>
                  </div>
                  <div>
                    <span>Budget</span>
                    <strong>{formatMoney(selected.budgetMinor)}</strong>
                  </div>
                  <div>
                    <span>Revision</span>
                    <strong>{selected.revision}</strong>
                  </div>
                </div>
                <div className="justification">
                  <span>Business justification</span>
                  <p>{selected.justification}</p>
                </div>
              </section>

              {role === "requester" && selected.stage === "draft" ? (
                <section className="content-card">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Draft</p>
                      <h2>Edit before submission</h2>
                    </div>
                  </div>
                  <FieldForm
                    action="Save changes"
                    busy={busy}
                    initial={selected}
                    onSubmit={(value) => perform(() => updateDraft(identity, selected, value))}
                  />
                  <hr />
                  <div className="submit-row">
                    <div>
                      <strong>Ready for review?</strong>
                      <p>Submission freezes revision 0 and creates mandatory audit evidence.</p>
                    </div>
                    <button className="primary" disabled={busy} onClick={() => void perform(() => submitDraft(identity, selected))}>
                      Submit requisition
                    </button>
                  </div>
                </section>
              ) : null}

              {role === "requester" && selected.stage === "needs-rework" ? (
                <section className="content-card">
                  <p className="eyebrow">Revision {selected.revision + 1}</p>
                  <h2>Respond to requested changes</h2>
                  <FieldForm
                    action="Revise and resubmit"
                    busy={busy}
                    initial={selected}
                    onSubmit={(value) => perform(() => resubmitRequisition(identity, selected, value))}
                  />
                </section>
              ) : null}

              {role === "approver" && selected.stage === "awaiting-review" ? (
                <ReviewPanel
                  busy={busy}
                  onReview={(decision, reason) => perform(() => reviewRequisition(identity, selected, decision, reason))}
                />
              ) : null}

              <AuditTimeline row={selected} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
