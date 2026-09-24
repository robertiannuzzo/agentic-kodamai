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
  publishAdvert,
  resubmitRequisition,
  reviewRequisition,
  submitDraft,
  updateDraft,
  type DemoIdentity
} from "./api";
import { CandidateWorkspace } from "./candidate";
import { describeError } from "./messages";
import { AdvertPanel, ApplicationsPanel, PeoplePanel, PublishAdvertForm } from "./recruiting";

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

const roles: ReadonlyArray<{ role: DemoRole; label: string }> = [
  { role: "requester", label: "Requester" },
  { role: "approver", label: "Approver" },
  { role: "recruiter", label: "Recruiter" },
  { role: "candidate", label: "Candidate" }
];

const defaultCandidate = "candidate@example.test";

/** The staff queue each role works from first. */
function queueFor(role: DemoRole, actor: string, rows: RequisitionCase[]): RequisitionCase[] {
  if (role === "approver") {
    return rows.filter((row) => row.stage === "awaiting-review" && row.requesterId !== actor);
  }
  if (role === "recruiter") return rows.filter((row) => row.stage === "approved");
  return [];
}

type DisplayCurrency = "GBP" | "USD";

// Budgets are stored in pence. US dollars are a display conversion at a fixed,
// indicative rate, not a live exchange rate.
const INDICATIVE_USD_PER_GBP = 1.27;
const currencyStorageKey = "kodamai.displayCurrency";

function formatMoney(minor: number, currency: DisplayCurrency = "GBP"): string {
  const pounds = minor / 100;
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(currency === "GBP" ? pounds : pounds * INDICATIVE_USD_PER_GBP);
}

function storedCurrency(): DisplayCurrency {
  try {
    return window.localStorage.getItem(currencyStorageKey) === "USD" ? "USD" : "GBP";
  } catch {
    return "GBP";
  }
}

function formatTime(tick: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(tick));
}

function FieldForm({
  initial,
  action,
  busy,
  currency,
  onSubmit,
  onCancel
}: {
  initial: RequisitionFields;
  action: string;
  busy: boolean;
  currency: DisplayCurrency;
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
          Annual budget (GBP)
          <input
            required
            min="1"
            step="1"
            type="number"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          {currency === "USD" && Number(budget) > 0 ? (
            <small className="field-hint">
              ≈ {formatMoney(Math.round(Number(budget) * 100), "USD")} at an indicative rate
            </small>
          ) : null}
        </label>
      </div>
      <label>
        Business justification
        <textarea
          required
          rows={5}
          value={value.justification}
          onChange={(event) => setValue({ ...value, justification: event.target.value })}
          placeholder="Why does the organisation need this role?"
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
      <ol className="timeline" aria-label="Audit timeline">
        {[...row.history].reverse().map((entry, index) => (
          <li key={`${entry.tick}-${entry.event}-${index}`}>
            <span className="timeline-marker" aria-hidden="true" />
            <div>
              <strong data-testid="event">{entry.event.replaceAll("-", " ")}</strong>
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
  const [currency, setCurrency] = useState<DisplayCurrency>(storedCurrency);

  function chooseCurrency(next: DisplayCurrency): void {
    setCurrency(next);
    try {
      window.localStorage.setItem(currencyStorageKey, next);
    } catch {
      // Storage can be unavailable; the choice still applies for this session.
    }
  }
  const [candidateEmail, setCandidateEmail] = useState(defaultCandidate);
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

  const selected = rows.find(({ reference }) => reference === selectedReference) ?? null;
  const inbox = queueFor(role, identity.actor, rows);
  const others = rows.filter((row) => !inbox.includes(row));
  const queueTitle = role === "approver" ? "Awaiting your review" : "Ready to advertise";
  const queueEmpty =
    role === "approver"
      ? "Nothing is waiting for your review."
      : "No approved requisitions are waiting for an advert.";

  const load = useCallback(async () => {
    if (identity.role === "candidate") {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listRequisitions(identity);
      setRows(result);
      const waiting = queueFor(identity.role, identity.actor, result)[0];
      setSelectedReference((current) =>
        result.some(({ reference }) => reference === current)
          ? current
          : (waiting ?? result[0])?.reference ?? null
      );
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
      setError(describeError(message));
    } finally {
      setBusy(false);
    }
  }

  function renderRow(row: RequisitionCase) {
    return (
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
    );
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
        <div className="topbar-controls">
          {role === "candidate" ? null : (
            <div className="role-switch" role="group" aria-label="Display currency">
              <span>Currency</span>
              {(["GBP", "USD"] as const).map((option) => (
                <button
                  aria-pressed={currency === option}
                  className={currency === option ? "active" : ""}
                  key={option}
                  onClick={() => chooseCurrency(option)}
                >
                  {option === "GBP" ? "£ GBP" : "$ USD"}
                </button>
              ))}
            </div>
          )}
          <div className="role-switch" aria-label="Demo role">
            <span>Viewing as</span>
            {roles.map((option) => (
              <button
                className={role === option.role ? "active" : ""}
                key={option.role}
                onClick={() => {
                  setRole(option.role);
                  setCreating(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {role === "candidate" ? (
            <label className="candidate-identity">
              <span>Applying as</span>
              <input
                aria-label="Candidate email"
                defaultValue={candidateEmail}
                type="email"
                onBlur={(event) => setCandidateEmail(event.target.value.trim() || defaultCandidate)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
          ) : null}
        </div>
      </header>

      {role === "candidate" ? (
        <CandidateWorkspace identity={identity} describeError={describeError} />
      ) : (
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
            {role !== "requester" && !loading ? (
              <>
                <h2 className="list-heading">
                  {queueTitle} <span className="count">{inbox.length}</span>
                </h2>
                {inbox.length === 0 ? <p className="empty compact">{queueEmpty}</p> : null}
                <nav className="requisition-list" aria-label={queueTitle}>
                  {inbox.map(renderRow)}
                </nav>
                {others.length > 0 ? <h2 className="list-heading">All requisitions</h2> : null}
              </>
            ) : null}
            <nav className="requisition-list" aria-label={role === "requester" ? "Your requisitions" : "All requisitions"}>
              {others.map(renderRow)}
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
                  currency={currency}
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
                    <span className={`status-badge ${selected.stage}`} data-testid="stage">
                      {selected.stage === "advertising" && selected.hired >= selected.headcount
                        ? "Filled"
                        : stageLabels[selected.stage]}
                    </span>
                  </div>
                  <div className="facts">
                    <div>
                      <span>Department</span>
                      <strong>{selected.department}</strong>
                    </div>
                    <div>
                      <span>Headcount</span>
                      <strong data-testid="headcount">{selected.headcount}</strong>
                      {selected.hired > 0 ? (
                        <small data-testid="hired">{selected.hired} hired</small>
                      ) : null}
                    </div>
                    <div>
                      <span>Budget</span>
                      <strong>{formatMoney(selected.budgetMinor, currency)}</strong>
                      {currency === "USD" ? (
                        <small>Stored as {formatMoney(selected.budgetMinor)}</small>
                      ) : null}
                    </div>
                    <div>
                      <span>Revision</span>
                      <strong data-testid="revision">{selected.revision}</strong>
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
                      currency={currency}
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
                      currency={currency}
                      initial={selected}
                      onSubmit={(value) => perform(() => resubmitRequisition(identity, selected, value))}
                    />
                  </section>
                ) : null}

                {role === "approver" &&
                selected.stage === "awaiting-review" &&
                selected.requesterId === identity.actor ? (
                  <section className="review-panel">
                    <p className="eyebrow">Separation of duties</p>
                    <p>You submitted this requisition, so another approver must review it.</p>
                  </section>
                ) : null}

                {role === "approver" &&
                selected.stage === "awaiting-review" &&
                selected.requesterId !== identity.actor ? (
                  <ReviewPanel
                    busy={busy}
                    onReview={(decision, reason) => perform(() => reviewRequisition(identity, selected, decision, reason))}
                  />
                ) : null}

                {role === "recruiter" && selected.stage === "approved" ? (
                  <PublishAdvertForm
                    busy={busy}
                    onPublish={(advert) => perform(() => publishAdvert(identity, selected, advert))}
                  />
                ) : null}

                {selected.advert === null ? null : <AdvertPanel advert={selected.advert} />}

                {role === "recruiter" && selected.stage === "advertising" ? (
                  <ApplicationsPanel
                  identity={identity}
                  reference={selected.reference}
                  openPositions={selected.headcount - selected.hired}
                  onHired={load}
                />
                ) : null}

                {selected.hired > 0 ? (
                <PeoplePanel identity={identity} reference={selected.reference} hired={selected.hired} />
              ) : null}

              <AuditTimeline row={selected} />
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
