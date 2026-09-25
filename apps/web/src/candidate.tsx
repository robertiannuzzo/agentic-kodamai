import { ArrowRight, Briefcase, CircleCheck, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApplicationSubmission, OpenAdvert } from "../../../packages/contracts/src/index";
import { applyToAdvert, listOpenAdverts, withdrawApplication, type DemoIdentity } from "./api";

function ApplyForm({
  advert,
  busy,
  defaultEmail,
  onApply
}: {
  advert: OpenAdvert;
  busy: boolean;
  defaultEmail: string;
  onApply(submission: ApplicationSubmission, email: string): Promise<void>;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState(defaultEmail);
  const [cvText, setCvText] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [years, setYears] = useState<Record<number, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onApply(
      {
        candidateName: `${firstName.trim()} ${lastName.trim()}`,
        cvText,
        acknowledgedPrivacyNotice: acknowledged,
        answers: advert.questions.map(({ questionId }) => ({ questionId, answer: answers[questionId] ?? "" })),
        years: advert.skills.map(({ skillId }) => ({ skillId, years: Number(years[skillId] ?? "0") }))
      },
      email.trim()
    );
  }

  return (
    <form className="form apply-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="group">
        <legend>
          <span className="step-number">01</span> About you
        </legend>
        <div className="form-grid">
          <label>
            First name
            <input
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </label>
          <label>
            Last name
            <input
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </label>
        </div>
        <label>
          Email
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
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
              We use your application only to consider you for this role, and we ask only for what we need.
            </li>
            <li>
              Every applicant is scored by the same fixed rules. A person reads every application and makes every
              decision; the score never decides on its own.
            </li>
            <li>
              We keep your application for {advert.retentionDays} days, then remove your personal data
              automatically. You can withdraw and erase it at any time from this page.
            </li>
            <li>
              If you are hired, your employment record is kept separately under your contract of employment;
              withdrawing erases the application, not that record.
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
  describeError,
  onIdentity
}: {
  identity: DemoIdentity;
  describeError(code: string): string;
  /** The email an application is submitted with becomes the candidate identity. */
  onIdentity(email: string): void;
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
    setBusy(false);
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

  // Actions for one candidate must not change what the next candidate sees:
  // a result that arrives after the identity changed is dropped.
  async function withdraw(): Promise<void> {
    if (advert === null) return;
    const current = generation.current;
    const reference = advert.reference;
    setBusy(true);
    setError(null);
    try {
      await withdrawApplication(identity, reference);
      if (current !== generation.current) return;
      setAdverts((existing) => existing.map((a) => (a.reference === reference ? { ...a, applied: false } : a)));
      setConfirmingWithdrawal(false);
    } catch (failure) {
      if (current !== generation.current) return;
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function apply(submission: ApplicationSubmission, email: string): Promise<void> {
    if (advert === null) return;
    const current = generation.current;
    const reference = advert.reference;
    setBusy(true);
    setError(null);
    try {
      await applyToAdvert({ ...identity, actor: email }, reference, submission);
      if (current !== generation.current) return;
      if (email !== identity.actor) {
        // Switching identity reloads the roles for that email, marked applied.
        onIdentity(email);
        return;
      }
      setAdverts((existing) => existing.map((a) => (a.reference === reference ? { ...a, applied: true } : a)));
    } catch (failure) {
      if (current !== generation.current) return;
      setError(describeError(failure instanceof Error ? failure.message : "request-failed"));
    } finally {
      if (current === generation.current) setBusy(false);
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
              {advert.questions.length} screening {advert.questions.length === 1 ? "question" : "questions"}.
              Every application is read by a person.
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
                      <span className="muted">This erases the personal data in your application: name, email, CV and answers.</span>
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
              <ApplyForm
                key={`${advert.reference}:${identity.actor}`}
                advert={advert}
                busy={busy}
                defaultEmail={identity.actor}
                onApply={apply}
              />
            )}
          </section>
        )}
      </main>
    </div>
  );
}
