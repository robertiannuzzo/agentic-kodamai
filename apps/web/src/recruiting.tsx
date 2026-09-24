import { useEffect, useState, type FormEvent } from "react";
import type { AdvertSchema, ApplicationRecord } from "../../../packages/contracts/src/index";
import { listApplications, type AdvertDraft, type DemoIdentity } from "./api";

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

export function ApplicationsPanel({ identity, reference }: { identity: DemoIdentity; reference: number }) {
  const [records, setRecords] = useState<ApplicationRecord[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRecords(null);
    setFailed(null);
    listApplications(identity, reference)
      .then((result) => {
        if (active) setRecords(result);
      })
      .catch((error: unknown) => {
        if (active) setFailed(error instanceof Error ? error.message : "Unable to load applications");
      });
    return () => {
      active = false;
    };
  }, [identity, reference]);

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
        decision.
      </p>
      {failed !== null ? <p role="alert">{failed}</p> : null}
      {records === null && failed === null ? <p className="empty compact">Loading…</p> : null}
      {records?.length === 0 ? <p className="empty compact">No applications yet.</p> : null}
      <ol className="application-list">
        {records?.map((record) => (
          <li key={record.applicationId}>
            <details>
              <summary>
                <span className="candidate">
                  <strong>{record.candidateName}</strong>
                  <small>Application {record.applicationId}</small>
                </span>
                <ScoreBar record={record} />
                <span className="total" aria-label={`Total ${record.total} of ${maximumScore(record)}`}>
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
              <p className="evidence-line">
                Evidence: {record.evidence.detail} · scored for {record.candidateActor}
              </p>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
