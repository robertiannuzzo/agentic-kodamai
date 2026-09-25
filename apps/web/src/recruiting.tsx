import { IdCard, Lock, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type {
  AdvertSchema,
  ApplicationRecord,
  Disposition,
  EmployeeRecord
} from "../../../packages/contracts/src/index";
import {
  eraseApplication,
  hireApplication,
  listPeople,
  reviewApplication,
  type AdvertDraft,
  type DemoIdentity
} from "./api";
import { displayName, employeeReference, initials } from "./format";
import { describeError } from "./messages";

const blankQuestion = { prompt: "", expected: "" };
const blankSkill = { keyword: "", weight: 1, targetYears: 1 };

export function PublishAdvertForm({ busy, onPublish }: { busy: boolean; onPublish(advert: AdvertDraft): Promise<void> }) {
  const [questions, setQuestions] = useState([{ ...blankQuestion }]);
  const [skills, setSkills] = useState([{ ...blankSkill }]);

  function updateQuestion(index: number, change: Partial<typeof blankQuestion>): void {
    setQuestions((current) => current.map((q, i) => (i === index ? { ...q, ...change } : q)));
  }

  function updateSkill(index: number, change: Partial<typeof blankSkill>): void {
    setSkills((current) => current.map((s, i) => (i === index ? { ...s, ...change } : s)));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onPublish({ questions, skills });
  }

  return (
    <section className="panel">
      <p className="eyebrow">Recruiter action</p>
      <h2>Publish the advert</h2>
      <p className="lede">
        Once published, the questions and skills can't be changed, so every applicant is scored the same way.
      </p>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <fieldset className="group">
          <legend>
            <span className="step-number">01</span> Screening questions
          </legend>
          {questions.map((question, index) => (
            <div className="schema-row question" key={index}>
              <label>
                Question {index + 1}
                <input
                  required
                  value={question.prompt}
                  onChange={(event) => updateQuestion(index, { prompt: event.target.value })}
                  placeholder="Can you work in the UK time zone?"
                />
              </label>
              <label>
                Expected answer
                <input
                  required
                  value={question.expected}
                  onChange={(event) => updateQuestion(index, { expected: event.target.value })}
                  placeholder="yes"
                />
              </label>
              {questions.length > 1 ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove question ${index + 1}`}
                  onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          ))}
          <button
            className="button ghost small"
            type="button"
            onClick={() => setQuestions((current) => [...current, { ...blankQuestion }])}
          >
            <Plus size={15} aria-hidden="true" /> Add question
          </button>
        </fieldset>
        <fieldset className="group">
          <legend>
            <span className="step-number">02</span> Weighted skills
          </legend>
          {skills.map((skill, index) => (
            <div className="schema-row skill" key={index}>
              <label>
                Skill {index + 1} keyword
                <input
                  required
                  value={skill.keyword}
                  onChange={(event) => updateSkill(index, { keyword: event.target.value })}
                  placeholder="idris"
                />
              </label>
              <label>
                Weight
                <input
                  required
                  min="1"
                  type="number"
                  value={skill.weight}
                  onChange={(event) => updateSkill(index, { weight: Number(event.target.value) })}
                />
              </label>
              <label>
                Target years
                <input
                  required
                  min="1"
                  type="number"
                  value={skill.targetYears}
                  onChange={(event) => updateSkill(index, { targetYears: Number(event.target.value) })}
                />
              </label>
              {skills.length > 1 ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove skill ${index + 1}`}
                  onClick={() => setSkills((current) => current.filter((_, i) => i !== index))}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          ))}
          <button
            className="button ghost small"
            type="button"
            onClick={() => setSkills((current) => [...current, { ...blankSkill }])}
          >
            <Plus size={15} aria-hidden="true" /> Add skill
          </button>
        </fieldset>
        <div className="actions">
          <button className="button primary" disabled={busy} type="submit">
            {busy ? "Publishing…" : "Publish advert"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function AdvertPanel({ advert }: { advert: AdvertSchema }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Published advert</p>
          <h2>Questions and skills</h2>
        </div>
        <Lock size={18} aria-hidden="true" className="muted-icon" />
      </div>
      <p className="lede">
        These can't be changed now the advert is live, so everyone is scored against the same questions.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Question</th>
            <th scope="col">Expected</th>
          </tr>
        </thead>
        <tbody>
          {advert.questions.map((q) => (
            <tr key={q.questionId}>
              <td className="numeric">{String(q.questionId).padStart(2, "0")}</td>
              <td>{q.prompt}</td>
              <td>{q.expected}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Skill</th>
            <th scope="col" className="numeric">
              Weight
            </th>
            <th scope="col" className="numeric">
              Target years
            </th>
          </tr>
        </thead>
        <tbody>
          {advert.skills.map((s) => (
            <tr key={s.skillId}>
              <td className="numeric">{String(s.skillId).padStart(2, "0")}</td>
              <td>{s.keyword}</td>
              <td className="numeric">{s.weight}</td>
              <td className="numeric">{s.targetYears}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const components = ["keywords", "experience", "screening", "completeness"] as const;

/** The most policy v1 can award for this advert, so bars share one scale. */
function maximumScore(record: ApplicationRecord): number {
  const questions = record.answers.length;
  return (
    record.experience.reduce((sum, skill) => sum + skill.weight + skill.weight * skill.targetYears, 0) +
    10 * questions +
    questions +
    1
  );
}

function ScoreBar({ record }: { record: ApplicationRecord }) {
  const unused = Math.max(0, maximumScore(record) - record.total);
  return (
    <div className="score-bar" aria-hidden="true">
      {components.map((part) =>
        record.breakdown[part] > 0 ? (
          <span className={`segment ${part}`} key={part} style={{ flexGrow: record.breakdown[part] }} />
        ) : null
      )}
      {unused > 0 ? <span className="segment unused" style={{ flexGrow: unused }} /> : null}
    </div>
  );
}

function decisionOf(record: ApplicationRecord): { label: string; tone: string } {
  if (record.employeeId !== null) return { label: `Hired · ${employeeReference(record.employeeId)}`, tone: "emerald" };
  if (record.erasedAt !== null) return { label: "Erased", tone: "neutral" };
  if (record.review === null) return { label: "Awaiting decision", tone: "amber" };
  return record.review.disposition === "shortlist"
    ? { label: "Shortlisted", tone: "sky" }
    : { label: "Rejected", tone: "rose" };
}

function ReviewControls({
  busy,
  onReview
}: {
  busy: boolean;
  onReview(disposition: Disposition, reason: string, note: string): Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="drawer-section">
      <p className="eyebrow">Your decision</p>
      <label>
        Reason (required to reject)
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label>
        Private note
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="actions">
        <button className="button primary" disabled={busy} onClick={() => void onReview("shortlist", reason, note)}>
          Shortlist
        </button>
        <button className="button danger" disabled={busy} onClick={() => void onReview("reject", reason, note)}>
          Reject
        </button>
      </div>
    </div>
  );
}

function HireControl({
  busy,
  defaultName,
  onHire
}: {
  busy: boolean;
  defaultName: string;
  onHire(legalName: string, startDate: string): Promise<void>;
}) {
  const [legalName, setLegalName] = useState(defaultName);
  const [startDate, setStartDate] = useState("");
  return (
    <div className="drawer-section highlight">
      <p className="eyebrow">
        <IdCard size={13} aria-hidden="true" /> Hire
      </p>
      <p className="hint">This adds them to your people records, linked to this application.</p>
      <div className="form-grid">
        <label>
          Legal name
          <input value={legalName} onChange={(event) => setLegalName(event.target.value)} />
        </label>
        <label>
          Start date
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button className="button primary" disabled={busy} onClick={() => void onHire(legalName, startDate)}>
          Hire
        </button>
      </div>
    </div>
  );
}

function EraseControl({ busy, onErase }: { busy: boolean; onErase(reason: string): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <button className="text-button danger" onClick={() => setOpen(true)}>
        <Trash2 size={14} aria-hidden="true" /> Erase personal data…
      </button>
    );
  }
  return (
    <div className="drawer-section">
      <label>
        Reason for erasure
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Erasure request by email" />
      </label>
      <p className="hint">Removes their name, email, CV, answers and notes. The score and decision are kept anonymously.</p>
      <div className="actions">
        <button className="button danger" disabled={busy || reason.trim() === ""} onClick={() => void onErase(reason)}>
          Erase personal data
        </button>
        <button className="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ApplicantDrawer({
  record,
  identity,
  canHire,
  onClose,
  onChanged,
  notify
}: {
  record: ApplicationRecord;
  identity: DemoIdentity;
  canHire: boolean;
  onClose(): void;
  onChanged(): Promise<void>;
  notify(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const decision = decisionOf(record);

  useEffect(() => {
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  async function act(operation: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true);
    setFailed(null);
    try {
      await operation();
      await onChanged();
      notify(message);
    } catch (error) {
      setFailed(describeError(error instanceof Error ? error.message : "request-failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="drawer" aria-label="Applicant detail">
      <header className="drawer-header">
        <span className="avatar large" aria-hidden="true">
          {record.erasedAt === null ? initials(record.candidateName) : "—"}
        </span>
        <div>
          <h2>{record.candidateName}</h2>
          <p className="muted">
            Application {record.applicationId}
            {record.erasedAt === null ? ` · ${record.candidateActor}` : ""}
          </p>
        </div>
        <button className="icon-button" aria-label="Close applicant detail" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="drawer-body">
        <div className="score-summary">
          <span className={`chip ${decision.tone}`}>{decision.label}</span>
          <span className="big-number">
            {record.total}
            <small> / {maximumScore(record)}</small>
          </span>
        </div>
        <ScoreBar record={record} />
        <dl className="breakdown">
          {components.map((part) => (
            <div key={part}>
              <dt>
                <span className={`swatch ${part}`} aria-hidden="true" />
                {part}
              </dt>
              <dd>{record.breakdown[part]}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">The score is a guide. You make the decision.</p>

        {failed === null ? null : (
          <p className="inline-error" role="alert">
            {failed}
          </p>
        )}

        {record.review === null && record.erasedAt === null ? (
          <ReviewControls
            busy={busy}
            onReview={(disposition, reason, note) =>
              act(
                () => reviewApplication(identity, record, { disposition, reason, note }),
                disposition === "shortlist" ? `Shortlisted ${record.candidateName}` : `Rejected ${record.candidateName}`
              )
            }
          />
        ) : null}

        {record.review === null ? null : (
          <div className="drawer-section">
            <p className="eyebrow">
              <ShieldCheck size={13} aria-hidden="true" /> Recorded decision
            </p>
            <p>
              <strong>{record.review.disposition === "shortlist" ? "Shortlisted" : "Rejected"}</strong> by{" "}
              {displayName(record.review.evidence.actor)}
            </p>
            {record.review.reason === "" ? null : <p>Reason: {record.review.reason}</p>}
            {record.review.note === "" ? null : <p>Note: {record.review.note}</p>}
            <p className="evidence-line">{record.review.evidence.detail}</p>
          </div>
        )}

        {canHire && record.review?.disposition === "shortlist" && record.employeeId === null && record.erasedAt === null ? (
          <HireControl
            busy={busy}
            defaultName={record.candidateName}
            onHire={(legalName, startDate) =>
              act(() => hireApplication(identity, record, { legalName, startDate }), `Hired ${legalName}`)
            }
          />
        ) : null}

        {record.erasedAt === null ? (
          <>
            <div className="drawer-section">
              <p className="eyebrow">Answers</p>
              <ul className="answer-list">
                {record.answers.map((a) => (
                  <li key={a.questionId}>
                    <span>{a.prompt}</span>
                    <strong>{a.answer === "" ? "—" : a.answer}</strong>
                    <small>expected {a.expected}</small>
                  </li>
                ))}
              </ul>
            </div>
            <div className="drawer-section">
              <p className="eyebrow">Experience</p>
              <ul className="answer-list">
                {record.experience.map((e) => (
                  <li key={e.skillId}>
                    <span>{e.keyword}</span>
                    <strong>{e.years} years</strong>
                    <small>
                      weight {e.weight}, capped at {e.targetYears}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
            <div className="drawer-section">
              <p className="eyebrow">CV text</p>
              <p className="cv-text">{record.cvText}</p>
            </div>
          </>
        ) : (
          <p className="erased-line">
            Personal data erased ({record.erasureReason}). The score and decision are kept anonymously.
          </p>
        )}

        <p className="evidence-line">Reference: {record.evidence.detail}</p>
        {record.erasedAt === null ? (
          <EraseControl
            busy={busy}
            onErase={(reason) => act(() => eraseApplication(identity, record, reason), "Personal data erased")}
          />
        ) : null}
      </div>
    </section>
  );
}

export function ApplicantsBoard({
  identity,
  records,
  loadError,
  openPositions,
  onChanged,
  notify
}: {
  identity: DemoIdentity;
  records: ApplicationRecord[] | null;
  loadError: string | null;
  openPositions: number;
  onChanged(): Promise<void>;
  notify(message: string): void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = records?.find(({ applicationId }) => applicationId === selectedId) ?? null;

  return (
    <section className="panel" aria-labelledby="applications-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Review</p>
          <h2 id="applications-title">Applications</h2>
        </div>
        <div className="legend" aria-label="Score components">
          {components.map((part) => (
            <span key={part}>
              <span className={`swatch ${part}`} aria-hidden="true" />
              {part}
            </span>
          ))}
        </div>
      </div>
      <p className="lede">
        Ranked by score. The score is a guide, not a decision: you decide who to shortlist, and only shortlisted
        applicants can be hired.
      </p>
      {loadError !== null ? <p role="alert">{loadError}</p> : null}
      {records === null && loadError === null ? <p className="empty">Loading…</p> : null}
      {records?.length === 0 ? <p className="empty">No applications yet. They appear here as candidates apply.</p> : null}
      <ol className="applicant-list" aria-label="Applications">
        {records?.map((record) => {
          const decision = decisionOf(record);
          return (
            <li
              aria-label={`Application ${record.applicationId}`}
              className={record.applicationId === selectedId ? "selected" : ""}
              key={record.applicationId}
            >
              <button className="applicant-row" onClick={() => setSelectedId(record.applicationId)}>
                <span className="avatar" aria-hidden="true">
                  {record.erasedAt === null ? initials(record.candidateName) : "—"}
                </span>
                <span className="applicant-name">
                  <strong>{record.candidateName}</strong>
                  <small>Application {record.applicationId}</small>
                </span>
                <ScoreBar record={record} />
                <span className="total" data-testid="total" aria-label={`Total ${record.total} of ${maximumScore(record)}`}>
                  {record.total}
                  <small> / {maximumScore(record)}</small>
                </span>
                <span className={`chip ${decision.tone}`} data-testid="decision">
                  {decision.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {selected === null ? null : (
        <ApplicantDrawer
          key={selected.applicationId}
          record={selected}
          identity={identity}
          canHire={openPositions > 0}
          onClose={() => setSelectedId(null)}
          onChanged={onChanged}
          notify={notify}
        />
      )}
    </section>
  );
}

/** People hired against one requisition, each with the facts it came from. */
export function PeoplePanel({ identity, reference, hired }: { identity: DemoIdentity; reference: number; hired: number }) {
  const [people, setPeople] = useState<EmployeeRecord[]>([]);

  useEffect(() => {
    let active = true;
    listPeople(identity)
      .then((all) => {
        if (active) setPeople(all.filter((person) => person.provenance.reference === reference));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [identity, reference, hired]);

  return (
    <section className="panel" aria-labelledby="people-title">
      <p className="eyebrow">People</p>
      <h2 id="people-title">Hired from this requisition</h2>
      <p className="lede">
        Everyone hired for this role, and how they were chosen.
      </p>
      <ul className="people-list" aria-label="Hired people">
        {people.map((person) => (
          <li key={person.employeeId}>
            <div className="person">
              <span className="avatar large" aria-hidden="true">
                {initials(person.legalName)}
              </span>
              <div>
                <strong>{person.legalName}</strong>
                <small>
                  {employeeReference(person.employeeId)} · {person.role} · starts {person.startDate}
                </small>
              </div>
            </div>
            <ol className="provenance" aria-label={`Provenance of ${person.legalName}`}>
              <li>
                <span className="eyebrow">Scored</span>
                <span>Score {person.provenance.total}</span>
                <code>{person.provenance.scoring.detail}</code>
              </li>
              <li>
                <span className="eyebrow">Shortlisted</span>
                <span>by {displayName(person.provenance.shortlist.actor)}</span>
                <code>{person.provenance.shortlist.detail}</code>
              </li>
              <li>
                <span className="eyebrow">Hired</span>
                <span>by {displayName(person.evidence.actor)}</span>
                <code>{person.evidence.detail}</code>
              </li>
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}
