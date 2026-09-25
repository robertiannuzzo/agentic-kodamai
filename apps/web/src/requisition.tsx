import {
  Ban,
  BadgeCheck,
  CircleCheck,
  CircleDot,
  FilePen,
  FileText,
  Gavel,
  IdCard,
  Lock,
  Send,
  Undo2,
  Users,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ApplicationRecord,
  AuditEntry,
  DemoRole,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision
} from "../../../packages/contracts/src/index";
import {
  listApplications,
  publishAdvert,
  resubmitRequisition,
  reviewRequisition,
  submitDraft,
  updateDraft,
  type DemoIdentity
} from "./api";
import { displayName, formatMoney, formatTime, reference, type DisplayCurrency } from "./format";
import { describeError } from "./messages";
import { AdvertPanel, ApplicantsBoard, PeoplePanel, PublishAdvertForm } from "./recruiting";
import {
  availableTabs,
  defaultTab,
  describeEvidence,
  displayStage,
  railSteps,
  stageLabels,
  stageTones,
  type RailStep,
  type Tab
} from "./stages";

export function FieldForm({
  initial,
  action,
  busy,
  currency,
  onSubmit,
  onDirtyChange,
  onCancel
}: {
  initial: RequisitionFields;
  action: string;
  busy: boolean;
  currency: DisplayCurrency;
  onSubmit(fields: RequisitionFields): Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [budget, setBudget] = useState(String(initial.budgetMinor / 100));

  useEffect(() => {
    setValue(initial);
    setBudget(String(initial.budgetMinor / 100));
  }, [initial]);

  useEffect(() => {
    onDirtyChange?.(
      value.role !== initial.role || value.department !== initial.department ||
      value.headcount !== initial.headcount || value.justification !== initial.justification ||
      Math.round(Number(budget) * 100) !== initial.budgetMinor
    );
  }, [value, budget, initial, onDirtyChange]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onSubmit({ ...value, budgetMinor: Math.round(Number(budget) * 100) });
  }

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <div className="form-grid">
        <label>
          Role title
          <input
            required
            value={value.role}
            onChange={(event) => setValue({ ...value, role: event.target.value })}
            placeholder="Senior software engineer"
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
          <input required min="1" step="1" type="number" value={budget} onChange={(event) => setBudget(event.target.value)} />
          {currency === "USD" && Number(budget) > 0 ? (
            <small className="hint">≈ {formatMoney(Math.round(Number(budget) * 100), "USD")} at an indicative rate</small>
          ) : null}
        </label>
      </div>
      <label>
        Business justification
        <textarea
          required
          rows={4}
          value={value.justification}
          onChange={(event) => setValue({ ...value, justification: event.target.value })}
          placeholder="Why does the organisation need this role?"
        />
      </label>
      <div className="actions">
        <button className="button primary" disabled={busy} type="submit">
          {busy ? "Saving…" : action}
        </button>
        {onCancel === undefined ? null : (
          <button className="button" disabled={busy} type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ReviewPanel({ busy, onReview }: { busy: boolean; onReview(decision: ReviewDecision, reason: string): Promise<void> }) {
  const [reason, setReason] = useState("");
  return (
    <section className="panel action-panel">
      <p className="eyebrow">Your decision</p>
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
      <div className="actions">
        <button className="button primary" disabled={busy} onClick={() => void onReview("approve", "")}>
          Approve
        </button>
        <button className="button" disabled={busy} onClick={() => void onReview("hold", reason)}>
          Request changes
        </button>
        <button className="button danger" disabled={busy} onClick={() => void onReview("decline", reason)}>
          Decline
        </button>
      </div>
    </section>
  );
}

const stepIcons: Record<string, LucideIcon> = {
  raised: FileText,
  approved: CircleCheck,
  advert: Lock,
  applications: Users,
  hired: IdCard
};

function StageRail({ steps }: { steps: RailStep[] }) {
  return (
    <ol className="stage-rail" aria-label="Recruitment chain">
      {steps.map((step) => {
        const Icon = step.state === "stopped" ? Ban : (stepIcons[step.key] ?? CircleDot);
        return (
          <li className={`step ${step.state}`} key={step.key} aria-current={step.state === "current" ? "step" : undefined}>
            <span className="step-bar" aria-hidden="true" />
            <span className="step-label">
              <Icon size={15} aria-hidden="true" />
              {step.label}
            </span>
            <span className="step-detail">{step.detail}</span>
          </li>
        );
      })}
    </ol>
  );
}

const eventIcons: Record<string, LucideIcon> = {
  "draft-created": FilePen,
  "draft-updated": FilePen,
  submitted: Send,
  approved: BadgeCheck,
  declined: Ban,
  held: Undo2,
  revised: FilePen,
  "advert-created": Lock
};

function EvidenceRail({ history }: { history: AuditEntry[] }) {
  const [raw, setRaw] = useState(false);
  return (
    <aside className="evidence-rail" aria-labelledby="evidence-title">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">History</p>
          <h2 id="evidence-title">What happened</h2>
        </div>
        <button className="text-button" aria-pressed={raw} onClick={() => setRaw((value) => !value)}>
          {raw ? "Hide details" : "Technical details"}
        </button>
      </div>
      <ol className="timeline" aria-label="Audit timeline">
        {[...history].reverse().map((entry, index) => {
          const Icon = eventIcons[entry.event] ?? Gavel;
          return (
            <li key={`${entry.tick}-${entry.event}-${index}`}>
              <span className="timeline-icon" aria-hidden="true">
                <Icon size={14} />
              </span>
              <div>
                <strong data-testid="event">{entry.event.replaceAll("-", " ")}</strong>
                <p className={raw ? "raw" : ""}>{raw ? entry.detail : describeEvidence(entry)}</p>
                <small title={entry.actor}>
                  {displayName(entry.actor)} · rev {entry.revision} · {formatTime(entry.tick)}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

const tabLabels: Record<Tab, string> = {
  requisition: "Requisition",
  advert: "Advert",
  applicants: "Applicants",
  people: "Hires"
};

export function RequisitionView({
  row,
  role,
  identity,
  currency,
  busy,
  perform,
  onRefresh,
  notify
}: {
  row: RequisitionCase;
  role: DemoRole;
  identity: DemoIdentity;
  currency: DisplayCurrency;
  busy: boolean;
  perform(operation: () => Promise<RequisitionCase>, message: string): Promise<void>;
  onRefresh(): Promise<void>;
  notify(message: string): void;
}) {
  const stage = displayStage(row);
  const tabs = availableTabs(role, row);
  const [tab, setTab] = useState<Tab>(defaultTab(role, row));
  const [records, setRecords] = useState<ApplicationRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const showsApplicants = role === "recruiter" && row.stage === "advertising";

  const loadApplications = useCallback(async () => {
    if (!showsApplicants) return;
    try {
      setRecords(await listApplications(identity, row.reference));
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error instanceof Error ? error.message : "request-failed"));
    }
  }, [identity, row.reference, showsApplicants]);

  useEffect(() => {
    setRecords(null);
    void loadApplications();
  }, [loadApplications]);

  const activeTab = tabs.includes(tab) ? tab : "requisition";

  return (
    <div className="requisition">
      <section className="req-header">
        <div className="req-title">
          <div>
            <p className="eyebrow">
              {reference(row.reference)} · {row.department}
            </p>
            <h1>{row.role}</h1>
          </div>
          <div className="chips">
            <span className={`chip ${stageTones[stage]}`} data-testid="stage">
              {stageLabels[stage]}
            </span>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Headcount</dt>
            <dd>
              <span data-testid="headcount">{row.headcount}</span>
              {row.hired > 0 ? (
                <small data-testid="hired"> · {row.hired} hired</small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>
              {formatMoney(row.budgetMinor, currency)}
              {currency === "USD" ? <small> · {formatMoney(row.budgetMinor)} stored</small> : null}
            </dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd data-testid="revision">{row.revision}</dd>
          </div>
          <div>
            <dt>Requested by</dt>
            <dd>{displayName(row.requesterId)}</dd>
          </div>
        </dl>
        <StageRail steps={railSteps(row, records?.length ?? null)} />
      </section>

      <div className="req-body">
        <div className="req-main">
          <div className="tabs" role="tablist" aria-label="Requisition sections">
            {tabs.map((option) => (
              <button
                role="tab"
                tabIndex={activeTab === option ? 0 : -1}
                aria-selected={activeTab === option}
                aria-controls={`panel-${option}`}
                id={`tab-${option}`}
                className={activeTab === option ? "active" : ""}
                key={option}
                onClick={() => setTab(option)}
                onKeyDown={(event) => {
                  const index = tabs.indexOf(option);
                  const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
                    : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
                    : event.key === "Home" ? tabs[0]
                    : event.key === "End" ? tabs[tabs.length - 1] : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }}
              >
                {tabLabels[option]}
                {option === "applicants" && records !== null ? <span className="count">{records.length}</span> : null}
                {option === "people" ? <span className="count">{row.hired}</span> : null}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="tab-panel">
            {activeTab === "requisition" ? (
              <>
                <section className="panel">
                  <p className="eyebrow">Business justification</p>
                  <p className="prose">{row.justification}</p>
                </section>

                {role === "requester" && row.stage === "draft" ? (
                  <section className="panel">
                    <p className="eyebrow">Draft</p>
                    <h2>Edit before submission</h2>
                    <FieldForm
                      action="Save changes"
                      busy={busy}
                      currency={currency}
                      initial={row}
                      onDirtyChange={setDraftDirty}
                      onSubmit={(value) => perform(() => updateDraft(identity, row, value), "Draft saved")}
                    />
                    <div className="submit-row">
                      <div>
                        <strong>Ready for review?</strong>
                        <p>Once submitted, it can't be edited unless the approver asks for changes.</p>
                        {draftDirty ? <p role="status">Save your changes before submitting.</p> : null}
                      </div>
                      <button
                        className="button primary"
                        disabled={busy || draftDirty}
                        onClick={() => void perform(() => submitDraft(identity, row), "Submitted for review")}
                      >
                        Submit requisition
                      </button>
                    </div>
                  </section>
                ) : null}

                {role === "requester" && row.stage === "needs-rework" ? (
                  <section className="panel">
                    <p className="eyebrow">Revision {row.revision + 1}</p>
                    <h2>Respond to requested changes</h2>
                    <FieldForm
                      action="Revise and resubmit"
                      busy={busy}
                      currency={currency}
                      initial={row}
                      onSubmit={(value) => perform(() => resubmitRequisition(identity, row, value), "Resubmitted for review")}
                    />
                  </section>
                ) : null}

                {role === "approver" && row.stage === "awaiting-review" && row.requesterId === identity.actor ? (
                  <section className="panel notice-panel">
                    <p className="eyebrow">Needs another approver</p>
                    <p>You submitted this requisition, so another approver must review it.</p>
                  </section>
                ) : null}

                {role === "approver" && row.stage === "awaiting-review" && row.requesterId !== identity.actor ? (
                  <ReviewPanel
                    busy={busy}
                    onReview={(decision, reason) =>
                      perform(
                        () => reviewRequisition(identity, row, decision, reason),
                        decision === "approve" ? "Requisition approved" : decision === "hold" ? "Changes requested" : "Requisition declined"
                      )
                    }
                  />
                ) : null}
              </>
            ) : null}

            {activeTab === "advert" ? (
              row.advert !== null ? (
                <AdvertPanel advert={row.advert} />
              ) : (
                <PublishAdvertForm
                  busy={busy}
                  onPublish={(advert) => perform(() => publishAdvert(identity, row, advert), "Advert published")}
                />
              )
            ) : null}

            {activeTab === "applicants" ? (
              <ApplicantsBoard
                identity={identity}
                records={records}
                loadError={loadError}
                openPositions={row.headcount - row.hired}
                onChanged={async () => {
                  await loadApplications();
                  await onRefresh();
                }}
                notify={notify}
              />
            ) : null}

            {activeTab === "people" ? (
              <PeoplePanel identity={identity} reference={row.reference} hired={row.hired} />
            ) : null}
          </div>
        </div>
        <EvidenceRail history={row.history} />
      </div>
    </div>
  );
}
