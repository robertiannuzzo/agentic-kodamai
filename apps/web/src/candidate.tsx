import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApplicationSubmission, OpenAdvert } from "../../../packages/contracts/src/index";
import { applyToAdvert, listOpenAdverts, type DemoIdentity } from "./api";

function ApplyForm({
  advert,
  busy,
  onApply
}: {
  advert: OpenAdvert;
  busy: boolean;
  onApply(submission: ApplicationSubmission): Promise<void>;
}) {
  const [candidateName, setCandidateName] = useState("");
  const [cvText, setCvText] = useState("");
  const [consent, setConsent] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [years, setYears] = useState<Record<number, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onApply({
      candidateName,
      cvText,
      consent,
      answers: advert.questions.map(({ questionId }) => ({ questionId, answer: answers[questionId] ?? "" })),
      years: advert.skills.map(({ skillId }) => ({ skillId, years: Number(years[skillId] ?? "0") }))
    });
  }

  return (
    <form className="field-form" onSubmit={(event) => void submit(event)}>
      <label>
        Full name
        <input required value={candidateName} onChange={(event) => setCandidateName(event.target.value)} />
      </label>
      <fieldset className="schema-group">
        <legend>Screening questions</legend>
        {advert.questions.map((q) => (
          <label key={q.questionId}>
            {q.prompt}
            <input
              value={answers[q.questionId] ?? ""}
              onChange={(event) => setAnswers({ ...answers, [q.questionId]: event.target.value })}
            />
          </label>
        ))}
      </fieldset>
      <fieldset className="schema-group">
        <legend>Years of experience</legend>
        <div className="form-grid">
          {advert.skills.map((s) => (
            <label key={s.skillId}>
              {s.keyword}
              <input
                required
                min="0"
                type="number"
                value={years[s.skillId] ?? ""}
                onChange={(event) => setYears({ ...years, [s.skillId]: event.target.value })}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        CV
        <textarea
          required
          rows={8}
          value={cvText}
          onChange={(event) => setCvText(event.target.value)}
          placeholder="Paste the text of your CV"
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>
          I consent to Kodamai processing this application to assess my suitability for this role. My answers
          are scored by a fixed, published policy and every score is reviewed by a person.
        </span>
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || !consent} type="submit">
          {busy ? "Sending…" : "Submit application"}
        </button>
      </div>
    </form>
  );
}

export function CandidateWorkspace({
  identity,
  describeError
}: {
  identity: DemoIdentity;
  describeError(code: string): string;
}) {
  const [adverts, setAdverts] = useState<OpenAdvert[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listOpenAdverts(identity);
      setAdverts(result);
      setSelected((current) =>
        result.some(({ reference }) => reference === current) ? current : result[0]?.reference ?? null
      );
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      setLoading(false);
    }
  }, [identity, describeError]);

  useEffect(() => void load(), [load]);

  const advert = adverts.find(({ reference }) => reference === selected) ?? null;

  async function apply(submission: ApplicationSubmission): Promise<void> {
    if (advert === null) return;
    setBusy(true);
    setError(null);
    try {
      await applyToAdvert(identity, advert.reference, submission);
      setAdverts((current) =>
        current.map((a) => (a.reference === advert.reference ? { ...a, applied: true } : a))
      );
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">Careers</p>
            <h1>Open roles</h1>
          </div>
        </div>
        {loading ? <p className="empty">Loading…</p> : null}
        {!loading && adverts.length === 0 ? <p className="empty">No roles are open right now.</p> : null}
        <nav className="requisition-list" aria-label="Open roles">
          {adverts.map((a) => (
            <button
              className={a.reference === selected ? "selected" : ""}
              key={a.reference}
              onClick={() => setSelected(a.reference)}
            >
              <span className={`status-dot ${a.applied ? "approved" : "advertising"}`} />
              <span>
                <strong>{a.role}</strong>
                <small>
                  {a.department}
                  {a.applied ? " · Applied" : ""}
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
        {advert === null ? (
          <section className="welcome">
            <p className="eyebrow">Careers</p>
            <h1>No open roles</h1>
            <p>Roles appear here once a recruiter publishes an approved requisition.</p>
          </section>
        ) : (
          <section className="content-card">
            <p className="eyebrow">{advert.department}</p>
            <h1>{advert.role}</h1>
            <p className="lede">
              We look for experience with {advert.skills.map(({ keyword }) => keyword).join(", ")}.
            </p>
            {advert.applied ? (
              <div className="notice" role="status">
                <strong>Application received.</strong> A member of the team will review it. You can apply to each
                role once.
              </div>
            ) : (
              <ApplyForm key={advert.reference} advert={advert} busy={busy} onApply={apply} />
            )}
          </section>
        )}
      </main>
    </div>
  );
}
