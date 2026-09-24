import { Check, Moon, Settings2, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DemoRole } from "../../../packages/contracts/src/index";
import type { DisplayCurrency, Theme } from "./format";

const roles: ReadonlyArray<{ role: DemoRole; label: string }> = [
  { role: "requester", label: "Requester" },
  { role: "approver", label: "Approver" },
  { role: "recruiter", label: "Recruiter" },
  { role: "candidate", label: "Candidate" }
];

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30">
        <circle cx="16" cy="16" r="15" fill="currentColor" />
        <path d="M11 8.5v15M11.5 16l8-7.5M13.5 14l6.5 9.5" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}

function SettingsMenu({
  currency,
  onCurrency,
  theme,
  onTheme
}: {
  currency: DisplayCurrency;
  onCurrency(value: DisplayCurrency): void;
  theme: Theme;
  onTheme(value: Theme): void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent | KeyboardEvent): void {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="settings" ref={container}>
      <button
        className="icon-button"
        aria-label="Display settings"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings2 size={17} aria-hidden="true" />
      </button>
      {open ? (
        <div className="popover" role="group" aria-label="Display settings">
          <p className="label">Currency</p>
          <div className="segmented" role="group" aria-label="Display currency">
            {(["GBP", "USD"] as const).map((option) => (
              <button
                aria-pressed={currency === option}
                className={currency === option ? "active" : ""}
                key={option}
                onClick={() => onCurrency(option)}
              >
                {option === "GBP" ? "£ GBP" : "$ USD"}
              </button>
            ))}
          </div>
          <p className="hint">Budgets are stored in pounds. Dollars use a fixed, indicative rate.</p>
          <p className="label">Theme</p>
          <div className="segmented" role="group" aria-label="Theme">
            <button aria-pressed={theme === "dark"} className={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")}>
              <Moon size={14} aria-hidden="true" /> Dark
            </button>
            <button aria-pressed={theme === "light"} className={theme === "light" ? "active" : ""} onClick={() => onTheme("light")}>
              <Sun size={14} aria-hidden="true" /> Light
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Topbar({
  role,
  onRole,
  candidateEmail,
  onCandidateEmail,
  currency,
  onCurrency,
  theme,
  onTheme
}: {
  role: DemoRole;
  onRole(role: DemoRole): void;
  candidateEmail: string;
  onCandidateEmail(email: string): void;
  currency: DisplayCurrency;
  onCurrency(value: DisplayCurrency): void;
  theme: Theme;
  onTheme(value: Theme): void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Kodamai</span>
        <span className="brand-divider" aria-hidden="true" />
        <span className="brand-product">{role === "candidate" ? "Careers" : "Recruitment"}</span>
      </div>
      <div className="topbar-controls">
        <div className="persona" aria-label="Demo role">
          <span className="label">Demo as</span>
          {roles.map((option) => (
            <button
              className={role === option.role ? "active" : ""}
              key={option.role}
              onClick={() => onRole(option.role)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {role === "candidate" ? (
          <label className="candidate-identity">
            <span className="label">Applying as</span>
            <input
              aria-label="Candidate email"
              defaultValue={candidateEmail}
              type="email"
              onBlur={(event) => onCandidateEmail(event.target.value.trim())}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        ) : null}
        <SettingsMenu currency={currency} onCurrency={onCurrency} theme={theme} onTheme={onTheme} />
      </div>
    </header>
  );
}

export interface Toast {
  id: number;
  message: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div className="toast" key={toast.id}>
          <Check size={16} aria-hidden="true" />
          <span>{toast.message}</span>
          <button className="icon-button small" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function useToasts(): { toasts: Toast[]; notify(message: string): void; dismiss(id: number): void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  function dismiss(id: number): void {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }
  function notify(message: string): void {
    const id = next.current;
    next.current += 1;
    setToasts((current) => [...current.slice(-2), { id, message }]);
    window.setTimeout(() => dismiss(id), 3500);
  }
  return { toasts, notify, dismiss };
}
