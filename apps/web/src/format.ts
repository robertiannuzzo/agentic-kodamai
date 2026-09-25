export type DisplayCurrency = "GBP" | "USD";
export type Theme = "dark" | "light";

// Budgets are stored in pence. US dollars are a display conversion at a fixed,
// indicative rate, not a live exchange rate.
const INDICATIVE_USD_PER_GBP = 1.27;

export function formatMoney(minor: number, currency: DisplayCurrency = "GBP"): string {
  const pounds = minor / 100;
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(currency === "GBP" ? pounds : pounds * INDICATIVE_USD_PER_GBP);
}

export function formatTime(tick: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(tick));
}

export function reference(value: number): string {
  return `REQ-${String(value).padStart(4, "0")}`;
}

export function employeeReference(value: number): string {
  return `EMP-${String(value).padStart(4, "0")}`;
}

/**
 * A readable name for a person identified by email: "grace.field@example.test"
 * becomes "Grace Field", "approver@kodamai.test" becomes "Approver". Erased
 * pseudonyms are shown as-is.
 */
export function displayName(actor: string): string {
  if (actor.startsWith("erased:")) return "Erased candidate";
  return actor
    .replace(/@.*/u, "")
    .split(/[._-]+/u)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function initials(name: string): string {
  const parts = name.replace(/@.*/u, "").split(/[\s._-]+/u).filter((part) => part !== "");
  return (parts.length === 0 ? "?" : parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join(""));
}

/** Per-viewer conveniences only; the app works when storage is unavailable. */
export function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.find((option) => option === value) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}
