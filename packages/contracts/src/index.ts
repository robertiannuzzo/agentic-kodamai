export type DemoRole = "requester" | "approver" | "recruiter" | "candidate";

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

export interface AdvertQuestion {
  questionId: number;
  prompt: string;
  expected: string;
}

export interface AdvertSkill {
  skillId: number;
  keyword: string;
  weight: number;
  targetYears: number;
}

/** A published advert's frozen schema. Present only in the advertising stage. */
export interface AdvertSchema {
  questions: AdvertQuestion[];
  skills: AdvertSkill[];
}

export interface WorkflowCase extends RequisitionFields {
  reference: number;
  generation: number;
  revision: number;
  stage: RequisitionStage;
  history: AuditEntry[];
  advert: AdvertSchema | null;
}

export interface RequisitionCase extends WorkflowCase {
  tenantId: string;
  requesterId: string;
}

export type ReviewDecision = "approve" | "decline" | "hold";

export type WorkflowCommand =
  | {
      kind: "create-draft";
      reference: number;
      actor: string;
      tick: number;
      fields: RequisitionFields;
    }
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
    }
  | {
      kind: "publish";
      reference: number;
      generation: number;
      actor: string;
      tick: number;
      questions: AdvertQuestion[];
      skills: AdvertSkill[];
    };

/** A candidate's application as sent through the kernel's intake branch. */
export interface IntakeRequest {
  applicationId: number;
  actor: string;
  tick: number;
  cv: { locator: string; version: string; text: string };
  answers: Array<{ questionId: number; answer: string }>;
  years: Array<{ skillId: number; years: number }>;
}

export interface ScoreBreakdown {
  keywords: number;
  experience: number;
  screening: number;
  completeness: number;
}

export interface ScoreReceipt {
  applicationId: number;
  breakdown: ScoreBreakdown;
  total: number;
  policyVersion: string;
  evidence: AuditEntry;
}

/** Candidate-facing advert: no expected answers, weights or internal fields. */
export interface OpenAdvert {
  reference: number;
  role: string;
  department: string;
  questions: Array<{ questionId: number; prompt: string }>;
  skills: Array<{ skillId: number; keyword: string }>;
  applied: boolean;
  /** Days an application is kept before it is anonymised automatically. */
  retentionDays: number;
}

export interface ApplicationSubmission {
  candidateName: string;
  cvText: string;
  /** The candidate has read the privacy notice (lawful basis: steps before a contract). */
  acknowledgedPrivacyNotice: boolean;
  answers: Array<{ questionId: number; answer: string }>;
  years: Array<{ skillId: number; years: number }>;
}

/** What a candidate is told: receipt of the application, never its score. */
export interface ApplicationAcknowledgement {
  reference: number;
  applicationId: number;
  status: "received";
}

export type Disposition = "shortlist" | "reject";

/** A recruiter's recorded decision. The evidence is produced by the kernel. */
export interface ApplicationReview {
  reference: number;
  applicationId: number;
  disposition: Disposition;
  reason: string;
  note: string;
  evidence: AuditEntry;
}

/** Re-score the stored inputs and record a person's decision. */
export interface AssessRequest {
  application: IntakeRequest;
  stored: { breakdown: ScoreBreakdown; evidence: AuditEntry };
  reviewer: string;
  tick: number;
  disposition: Disposition;
  reason: string;
}

/** Recruiter-facing application with its score workings. */
export interface ApplicationRecord {
  reference: number;
  applicationId: number;
  candidateName: string;
  candidateActor: string;
  cvVersion: string;
  cvText: string;
  answers: Array<{ questionId: number; prompt: string; expected: string; answer: string }>;
  experience: Array<{ skillId: number; keyword: string; weight: number; targetYears: number; years: number }>;
  breakdown: ScoreBreakdown;
  total: number;
  policyVersion: string;
  evidence: AuditEntry;
  createdAt: number;
  review: ApplicationReview | null;
  /** Set when personal data was removed (withdrawal, request, or retention). */
  erasedAt: number | null;
  erasureReason: string | null;
}

export interface WorkflowResult {
  result: WorkflowCase;
}

export interface ApiError {
  error: string;
}
