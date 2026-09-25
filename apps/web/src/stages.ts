import type { AuditEntry, DemoRole, RequisitionCase } from "../../../packages/contracts/src/index";
import { displayName } from "./format";

/** What a requisition is, as shown to people. "Filled" is derived from hires. */
export type DisplayStage = RequisitionCase["stage"] | "filled";

export type Tone = "neutral" | "amber" | "emerald" | "orange" | "rose" | "sky";

export function displayStage(row: RequisitionCase): DisplayStage {
  return row.stage === "advertising" && row.hired >= row.headcount ? "filled" : row.stage;
}

export const stageLabels: Record<DisplayStage, string> = {
  draft: "Draft",
  "awaiting-review": "Awaiting review",
  approved: "Approved",
  "needs-rework": "Changes requested",
  declined: "Declined",
  advertising: "Advertising",
  filled: "Filled"
};

export const stageTones: Record<DisplayStage, Tone> = {
  draft: "neutral",
  "awaiting-review": "amber",
  approved: "emerald",
  "needs-rework": "orange",
  declined: "rose",
  advertising: "sky",
  filled: "emerald"
};

export type StepState = "done" | "current" | "todo" | "stopped";

export interface RailStep {
  key: string;
  label: string;
  detail: string;
  state: StepState;
  evidence: AuditEntry | undefined;
}

function last(history: AuditEntry[], event: string): AuditEntry | undefined {
  return [...history].reverse().find((entry) => entry.event === event);
}

/**
 * The spine as the person sees it: each link of the typed chain, with the
 * evidence that completed it. Mirrors `Seq` in the Idris kernel.
 */
export function railSteps(row: RequisitionCase, applications: number | null): RailStep[] {
  const stage = displayStage(row);
  const submitted = last(row.history, "submitted");
  const approved = last(row.history, "approved");
  const declined = last(row.history, "declined");
  const held = last(row.history, "held");
  const advert = last(row.history, "advert-created");
  const beyondApproval = stage === "approved" || stage === "advertising" || stage === "filled";
  const advertised = stage === "advertising" || stage === "filled";

  return [
    {
      key: "raised",
      label: "Raised",
      detail: row.revision > 0 ? `Revision ${row.revision}` : submitted === undefined ? "Draft" : "Submitted",
      state: stage === "draft" ? "current" : "done",
      evidence: submitted ?? last(row.history, "draft-created")
    },
    {
      key: "approved",
      label: stage === "declined" ? "Declined" : stage === "needs-rework" ? "Changes requested" : "Approved",
      detail:
        stage === "declined"
          ? "Stopped"
          : stage === "needs-rework"
            ? "Back with requester"
            : beyondApproval
              ? `By ${approved === undefined ? "approver" : displayName(approved.actor)}`
              : stage === "awaiting-review"
                ? "Awaiting review"
                : "Not yet",
      state:
        stage === "declined" ? "stopped" : beyondApproval ? "done" : stage === "draft" ? "todo" : "current",
      evidence: declined ?? (stage === "needs-rework" ? held : approved)
    },
    {
      key: "advert",
      label: "Advertised",
      detail:
        row.advert === null
          ? stage === "approved"
            ? "Ready to publish"
            : "Not yet"
          : `${row.advert.questions.length} questions · ${row.advert.skills.length} skills`,
      state: advertised ? "done" : stage === "approved" ? "current" : stage === "declined" ? "stopped" : "todo",
      evidence: advert
    },
    {
      key: "applications",
      label: "Applications",
      detail: !advertised
        ? "Not open"
        : applications !== null
          ? `${applications} received`
          : stage === "filled"
            ? "Closed"
            : "Open",
      state: !advertised
        ? stage === "declined"
          ? "stopped"
          : "todo"
        : stage === "filled" || (applications !== null && applications > 0)
          ? "done"
          : "current",
      evidence: undefined
    },
    {
      key: "hired",
      label: "Hired",
      detail: `${row.hired} of ${row.headcount}`,
      state: stage === "filled" ? "done" : row.hired > 0 ? "current" : stage === "declined" ? "stopped" : "todo",
      evidence: undefined
    }
  ];
}

/** A sentence for a person; the raw evidence stays one toggle away. */
export function describeEvidence(entry: AuditEntry): string {
  switch (entry.event) {
    case "draft-created":
      return "Draft created";
    case "draft-updated":
      return "Draft edited";
    case "submitted":
      return `Revision ${entry.revision} submitted for review`;
    case "approved":
      return `Revision ${entry.revision} approved`;
    case "declined":
      return `Declined: ${entry.detail}`;
    case "held":
      return `Changes requested: ${entry.detail}`;
    case "revised":
      return `Revised to revision ${entry.revision}`;
    case "advert-created":
      return "Advert published";
    default:
      return entry.detail;
  }
}

/** The queue each staff role works from first. */
export function queueFor(role: DemoRole, actor: string, rows: RequisitionCase[]): RequisitionCase[] {
  if (role === "approver") {
    return rows.filter((row) => row.stage === "awaiting-review" && row.requesterId !== actor);
  }
  if (role === "recruiter") return rows.filter((row) => row.stage === "approved");
  return [];
}

export type Tab = "requisition" | "advert" | "applicants" | "people";

/** Open where this role's next action is. */
export function defaultTab(role: DemoRole, row: RequisitionCase): Tab {
  if (role === "recruiter" && (row.stage === "advertising")) return "applicants";
  if (role === "recruiter" && row.stage === "approved") return "advert";
  return "requisition";
}

export function availableTabs(role: DemoRole, row: RequisitionCase): Tab[] {
  const tabs: Tab[] = ["requisition"];
  if (row.advert !== null || (role === "recruiter" && row.stage === "approved")) tabs.push("advert");
  if (role === "recruiter" && row.stage === "advertising") tabs.push("applicants");
  if (row.hired > 0) tabs.push("people");
  return tabs;
}
