export type DemoRole = "requester" | "approver";

export type RequisitionStage =
  | "draft"
  | "awaiting-review"
  | "approved"
  | "needs-rework"
  | "declined"
  | "advertising";

export interface RequisitionFields {
  role: string;
  department: string;
  headcount: number;
  budgetMinor: number;
  justification: string;
}

export interface AuditEntry {
  event: string;
  actor: string;
  tick: number;
  reference: number;
  revision: number;
  detail: string;
}

export interface RequisitionCase extends RequisitionFields {
  reference: number;
  generation: number;
  revision: number;
  stage: RequisitionStage;
  history: AuditEntry[];
}

export type ReviewDecision = "approve" | "decline" | "hold";

export type WorkflowCommand =
  | { kind: "create-draft"; actor: string; tick: number; fields: RequisitionFields }
  | {
      kind: "update-draft";
      reference: number;
      generation: number;
      actor: string;
      tick: number;
      fields: RequisitionFields;
    }
  | {
      kind: "submit-draft";
      reference: number;
      generation: number;
      actor: string;
      tick: number;
    }
  | {
      kind: "review";
      reference: number;
      generation: number;
      actor: string;
      tick: number;
      decision: ReviewDecision;
      reason: string;
    }
  | {
      kind: "resubmit";
      reference: number;
      generation: number;
      actor: string;
      tick: number;
      fields: RequisitionFields;
    };

export interface WorkflowResult {
  latestReference: number | null;
  cases: RequisitionCase[];
}

export interface ApiError {
  error: string;
}
