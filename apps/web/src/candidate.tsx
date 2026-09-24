import { ArrowRight, Briefcase, CircleCheck, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApplicationSubmission, OpenAdvert } from "../../../packages/contracts/src/index";
import { applyToAdvert, listOpenAdverts, withdrawApplication, type DemoIdentity } from "./api";

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
  const [acknowledged, setAcknowledged] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [years, setYears] = useState<Record<number, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onApply({
      candidateName,
      cvText,
      acknowledgedPrivacyNotice: acknowledged,
      answers: advert.questions.map(({ questionId }) => ({ questionId, answer: answers[questionId] ?? "" })),
      years: advert.skills.map(({ skillId }) => ({ skillId, years: Number(years[skillId] ?? "0") }))
    });
  }

  return (
    <form className="form apply-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="group">
        <legend>
          <span className="step-number">01</span> About you
        </legend>
        <label>
          Full name
          <input required value={candidateName} onChange={(event) => setCandidateName(event.target.value)} />
        </label>
      </fieldset>
      <fieldset className="group">
        <legend>
          <span className="step-number">02</span> Screening questions
        </legend>
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
      <fieldset className="group">
        <legend>
          <span className="step-number">03</span> Years of experience
        </legend>
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
      <fieldset className="group">
        <legend>
          <span className="step-number">04</span> CV and privacy
        </legend>
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
        <section className="privacy-notice" aria-labelledby={`privacy-${advert.reference}`}>
          <h3 id={`privacy-${advert.reference}`}>
            <ShieldCheck size={16} aria-hidden="true" /> How we use your application
          </h3>
          <ul>
            <li>
              Kodamai processes your application to take steps you have asked for before a possible employment
              contract. We ask only for what we need to assess it.
            </li>
            <li>
              Your answers and experience are scored by a fixed, versioned rule set. A person reviews every
              application and makes every decision; the score never decides on its own.
            </li>
            <li>
              We keep your application for {advert.retentionDays} days, then remove your personal data
              automatically. You can withdraw and erase it at any time from this page.
            </li>
          </ul>
        </section>
        <label className="checkbox">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I have read how my application will be used.</span>
        </label>
      </fieldset>
      <div className="actions">
        <button className="button primary" disabled={busy || !acknowledged} type="submit">
          {busy ? "Sending…" : "Submit application"}
          <ArrowRight size={16} aria-hidden="true" />
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

  // Adverts carry per-candidate "applied" state: ignore responses for an
  // earlier candidate identity and clear its data immediately.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setAdverts([]);
    setLoading(true);
    setError(null);
    try {
      const result = await listOpenAdverts(identity);
      if (current !== generation.current) return;
      setAdverts(result);
      setSelected((current) =>
        result.some(({ reference }) => reference === current) ? current : result[0]?.reference ?? null
      );
    } catch (failure) {
      if (current !== generation.current) return;
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [identity, describeError]);

  useEffect(() => void load(), [load]);

  const advert = adverts.find(({ reference }) => reference === selected) ?? null;
  const [confirmingWithdrawal, setConfirmingWithdrawal] = useState(false);

  useEffect(() => setConfirmingWithdrawal(false), [selected, identity]);

  async function withdraw(): Promise<void> {
    if (advert === null) return;
    setBusy(true);
    setError(null);
    try {
      await withdrawApplication(identity, advert.reference);
      setAdverts((current) =>
        current.map((a) => (a.reference === advert.reference ? { ...a, applied: false } : a))
      );
      setConfirmingWithdrawal(false);
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      setBusy(false);
    }
  }

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
        {loading ? (
          <div className="skeleton-list" aria-hidden="true">
            <span />
            <span />
          </div>
        ) : null}
        {!loading && adverts.length === 0 ? <p className="empty">No roles are open right now.</p> : null}
        <nav className="req-list" aria-label="Open roles">
          {adverts.map((a) => (
            <button
              className={a.reference === selected ? "req-row selected" : "req-row"}
              key={a.reference}
              onClick={() => setSelected(a.reference)}
            >
              <span className={`dot ${a.applied ? "emerald" : "sky"}`} aria-hidden="true" />
              <span className="req-row-text">
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
      <main className="main">
        {error === null ? null : (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="button small" onClick={() => void load()}>
              Reload
            </button>
          </div>
        )}
        {advert === null ? (
          <section className="welcome">
            <p className="eyebrow">
              <span className="pulse" aria-hidden="true" /> Careers at Kodamai
            </p>
            <h1 className="display">No open roles right now.</h1>
            <p className="lede">Roles appear here as soon as a recruiter publishes an approved requisition.</p>
          </section>
        ) : (
          <section className="panel role-panel">
            <p className="eyebrow">
              <Briefcase size={13} aria-hidden="true" /> {advert.department} · Open role
            </p>
            <h1 className="display">{advert.role}</h1>
            <div className="chips">
              {advert.skills.map(({ skillId, keyword }) => (
                <span className="chip neutral" key={skillId}>
                  {keyword}
                </span>
              ))}
            </div>
            <p className="lede">
              {advert.questions.length} short screening questions and your experience with{" "}
              {advert.skills.map(({ keyword }) => keyword).join(", ")}. Every application is read by a person.
            </p>
            {advert.applied ? (
              <>
                <div className="notice" role="status">
                  <CircleCheck size={18} aria-hidden="true" />
                  <div>
                    <strong>Application received.</strong> A member of the team will review it. You can apply to
                    each role once.
                  </div>
                </div>
                <div className="actions withdraw-row">
                  {confirmingWithdrawal ? (
                    <>
                      <span className="muted">This erases your name, email, CV and answers.</span>
                      <button className="button danger" disabled={busy} onClick={() => void withdraw()}>
                        Confirm withdrawal
                      </button>
                      <button className="button" disabled={busy} onClick={() => setConfirmingWithdrawal(false)}>
                        Keep my application
                      </button>
                    </>
                  ) : (
                    <button className="button ghost" onClick={() => setConfirmingWithdrawal(true)}>
                      Withdraw and erase my application
                    </button>
                  )}
                </div>
              </>
            ) : (
              <ApplyForm key={advert.reference} advert={advert} busy={busy} onApply={apply} />
            )}
          </section>
        )}
      </main>
    </div>
  );
}
