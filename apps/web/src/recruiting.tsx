import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  AdvertSchema,
  ApplicationRecord,
  Disposition,
  EmployeeRecord
} from "../../../packages/contracts/src/index";
import {
  eraseApplication,
  hireApplication,
  listApplications,
  listPeople,
  reviewApplication,
  type AdvertDraft,
  type DemoIdentity
} from "./api";
import { describeError } from "./messages";

const blankQuestion = { prompt: "", expected: "" };
const blankSkill = { keyword: "", weight: 1, targetYears: 1 };

export function PublishAdvertForm({
  busy,
  onPublish
}: {
  busy: boolean;
  onPublish(advert: AdvertDraft): Promise<void>;
}) {
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
    <section className="content-card">
      <p className="eyebrow">Recruiter action</p>
      <h2>Publish the advert</h2>
      <p className="lede">
        Screening questions and weighted skills are frozen at publication. Every application and score is
        typed by this exact advert, so there is no edit afterwards.
      </p>
      <form className="field-form" onSubmit={(event) => void submit(event)}>
        <fieldset className="schema-group">
          <legend>Screening questions</legend>
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
              <label className="narrow">
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
                  ×
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          ))}
          <button type="button" onClick={() => setQuestions((current) => [...current, { ...blankQuestion }])}>
            Add question
          </button>
        </fieldset>
        <fieldset className="schema-group">
          <legend>Weighted skills</legend>
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
              <label className="narrow">
                Weight
                <input
                  required
                  min="1"
                  type="number"
                  value={skill.weight}
                  onChange={(event) => updateSkill(index, { weight: Number(event.target.value) })}
                />
              </label>
              <label className="narrow">
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
                  ×
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          ))}
          <button type="button" onClick={() => setSkills((current) => [...current, { ...blankSkill }])}>
            Add skill
          </button>
        </fieldset>
        <div className="button-row">
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Publishing…" : "Publish advert"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function AdvertPanel({ advert }: { advert: AdvertSchema }) {
  return (
    <section className="content-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Published advert</p>
          <h2>Frozen schema</h2>
        </div>
        <span className="frozen-badge">Frozen</span>
      </div>
      <p className="lede">
        Applications and scores are typed by this exact advert. Changing a question underneath them does not
        compile (<code>SwapQuestions.idr</code>), the database refuses the update, and a changed stored schema
        fails its publication fingerprint on replay.
      </p>
      <table className="schema-table">
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
              <td>{q.questionId}</td>
              <td>{q.prompt}</td>
              <td>{q.expected}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="schema-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Skill</th>
            <th scope="col">Weight</th>
            <th scope="col">Target years</th>
          </tr>
        </thead>
        <tbody>
          {advert.skills.map((s) => (
            <tr key={s.skillId}>
              <td>{s.skillId}</td>
              <td>{s.keyword}</td>
              <td>{s.weight}</td>
              <td>{s.targetYears}</td>
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
    <div className="review-controls">
      <label>
        Reason (required to reject)
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label>
        Private note
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void onReview("shortlist", reason, note)}>
          Shortlist
        </button>
        <button className="danger" disabled={busy} onClick={() => void onReview("reject", reason, note)}>
          Reject
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
      <button className="link-button" onClick={() => setOpen(true)}>
        Erase personal data…
      </button>
    );
  }
  return (
    <div className="erase-control">
      <label>
        Reason for erasure
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Erasure request by email" />
      </label>
      <p>Removes the name, email, CV text, answers and review notes. The score and evidence remain.</p>
      <div className="button-row">
        <button className="danger" disabled={busy || reason.trim() === ""} onClick={() => void onErase(reason)}>
          Erase personal data
        </button>
        <button disabled={busy} onClick={() => setOpen(false)}>
          Cancel
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
    <div className="hire-control">
      <p>
        Hiring creates a people record that carries proof of this application. There is no hire without it.
      </p>
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
      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void onHire(legalName, startDate)}>
          Hire
        </button>
      </div>
    </div>
  );
}

function ApplicationItem({
  record,
  identity,
  canHire,
  onChanged
}: {
  record: ApplicationRecord;
  identity: DemoIdentity;
  canHire: boolean;
  onChanged(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const status =
    record.employeeId !== null
      ? `Hired · EMP-${String(record.employeeId).padStart(4, "0")}`
      : record.erasedAt !== null
      ? "Erased"
      : record.review === null
        ? "Awaiting decision"
        : record.review.disposition === "shortlist"
          ? "Shortlisted"
          : "Rejected";

  async function act(operation: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setFailed(null);
    try {
      await operation();
      await onChanged();
    } catch (error) {
      setFailed(describeError(error instanceof Error ? error.message : "request-failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li aria-label={`Application ${record.applicationId}`}>
      <details>
        <summary>
          <span className="candidate">
            <strong>{record.candidateName}</strong>
            <small>
              Application {record.applicationId} · <span data-testid="decision">{status}</span>
            </small>
          </span>
          <ScoreBar record={record} />
          <span
            className="total"
            data-testid="total"
            aria-label={`Total ${record.total} of ${maximumScore(record)}`}
          >
            {record.total}
            <small> / {maximumScore(record)}</small>
          </span>
        </summary>
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
        {failed === null ? null : (
          <p className="inline-error" role="alert">
            {failed}
          </p>
        )}
        {record.review === null && record.erasedAt === null ? (
          <ReviewControls
            busy={busy}
            onReview={(disposition, reason, note) =>
              act(() => reviewApplication(identity, record, { disposition, reason, note }))
            }
          />
        ) : null}
        {record.review === null ? null : (
          <div className="decision">
            <strong>{record.review.disposition === "shortlist" ? "Shortlisted" : "Rejected"}</strong> by{" "}
            {record.review.evidence.actor}
            {record.review.reason === "" ? null : <p>Reason: {record.review.reason}</p>}
            {record.review.note === "" ? null : <p>Note: {record.review.note}</p>}
            <small>Evidence: {record.review.evidence.detail}</small>
          </div>
        )}
        {canHire && record.review?.disposition === "shortlist" && record.employeeId === null && record.erasedAt === null ? (
          <HireControl
            busy={busy}
            defaultName={record.candidateName}
            onHire={(legalName, startDate) =>
              act(() => hireApplication(identity, record, { legalName, startDate }))
            }
          />
        ) : null}
        {record.erasedAt === null ? null : (
          <p className="erased-line">
            Personal data erased: {record.erasureReason}. The score and evidence are kept without identifying the
            candidate.
          </p>
        )}
        {record.erasedAt !== null ? null : (
          <>
            <h3>Answers</h3>
            <ul className="answer-list">
              {record.answers.map((a) => (
                <li key={a.questionId}>
                  <span>{a.prompt}</span>
                  <strong>{a.answer === "" ? "—" : a.answer}</strong>
                  <small>expected {a.expected}</small>
                </li>
              ))}
            </ul>
            <h3>Experience</h3>
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
            <h3>CV text</h3>
            <p className="cv-text">{record.cvText}</p>
          </>
        )}
        <p className="evidence-line">
          Evidence: {record.evidence.detail}
          {record.erasedAt === null ? ` · scored for ${record.candidateActor}` : ""}
        </p>
        {record.erasedAt === null ? (
          <EraseControl busy={busy} onErase={(reason) => act(() => eraseApplication(identity, record, reason))} />
        ) : null}
      </details>
    </li>
  );
}

export function ApplicationsPanel({
  identity,
  reference,
  openPositions,
  onHired
}: {
  identity: DemoIdentity;
  reference: number;
  openPositions: number;
  onHired(): Promise<void>;
}) {
  const [records, setRecords] = useState<ApplicationRecord[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRecords(await listApplications(identity, reference));
      setFailed(null);
    } catch (error) {
      setFailed(describeError(error instanceof Error ? error.message : "request-failed"));
    }
  }, [identity, reference]);

  useEffect(() => {
    setRecords(null);
    void load();
  }, [load]);

  return (
    <section className="content-card" aria-labelledby="applications-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Human review</p>
          <h2 id="applications-title">Applications</h2>
        </div>
        <span>{records === null ? "" : `${records.length} received`}</span>
      </div>
      <p className="lede">
        Scores are deterministic workings under a versioned policy to support review. They are not a hiring
        decision: each application needs a recorded decision by a person, and only a shortlisted application can be
        hired.
      </p>
      {failed !== null ? <p role="alert">{failed}</p> : null}
      {records === null && failed === null ? <p className="empty compact">Loading…</p> : null}
      {records?.length === 0 ? <p className="empty compact">No applications yet.</p> : null}
      <ol className="application-list" aria-label="Applications">
        {records?.map((record) => (
          <ApplicationItem
            key={record.applicationId}
            record={record}
            identity={identity}
            canHire={openPositions > 0}
            onChanged={async () => {
              await load();
              await onHired();
            }}
          />
        ))}
      </ol>
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

  if (people.length === 0) return null;
  return (
    <section className="content-card" aria-labelledby="people-title">
      <p className="eyebrow">People records</p>
      <h2 id="people-title">Hired from this requisition</h2>
      <ul className="people-list" aria-label="Hired people">
        {people.map((person) => (
          <li key={person.employeeId}>
            <div>
              <strong>{person.legalName}</strong>
              <small>
                EMP-{String(person.employeeId).padStart(4, "0")} · {person.role} · starts {person.startDate}
              </small>
            </div>
            <ol className="provenance" aria-label={`Provenance of ${person.legalName}`}>
              <li>
                Scored {person.provenance.total} under {person.provenance.policyVersion} — {person.provenance.scoring.detail}
              </li>
              <li>
                Shortlisted by {person.provenance.shortlist.actor} — {person.provenance.shortlist.detail}
              </li>
              <li>
                Hired by {person.evidence.actor} — {person.evidence.detail}
              </li>
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}
