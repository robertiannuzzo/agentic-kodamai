import type {
  ApiError,
  ApplicationAcknowledgement,
  ApplicationRecord,
  ApplicationReview,
  ApplicationSubmission,
  Disposition,
  DemoRole,
  EmployeeRecord,
  OpenAdvert,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision
} from "../../../packages/contracts/src/index";

export interface DemoIdentity {
  actor: string;
  role: DemoRole;
  tenantId: string;
}

async function request<T>(
  identity: DemoIdentity,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const mutating = init.method !== undefined && init.method !== "GET";
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-demo-actor": identity.actor,
      "x-demo-role": identity.role,
      "x-demo-tenant": identity.tenantId,
      ...(mutating ? { "idempotency-key": crypto.randomUUID() } : {}),
      ...init.headers
    }
  });
  if (response.status === 204) return undefined as T;
  const value = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const code = "error" in (value as ApiError) ? (value as ApiError).error : "request-failed";
    throw new Error(code);
  }
  return value as T;
}

export function listRequisitions(identity: DemoIdentity): Promise<RequisitionCase[]> {
  return request(identity, "/api/requisitions");
}

export function createDraft(
  identity: DemoIdentity,
  fields: RequisitionFields
): Promise<RequisitionCase> {
  return request(identity, "/api/requisitions", {
    method: "POST",
    body: JSON.stringify({ fields })
  });
}

export function updateDraft(
  identity: DemoIdentity,
  row: RequisitionCase,
  fields: RequisitionFields
): Promise<RequisitionCase> {
  return request(identity, `/api/requisitions/${row.reference}`, {
    method: "PUT",
    body: JSON.stringify({ generation: row.generation, fields })
  });
}

export function submitDraft(
  identity: DemoIdentity,
  row: RequisitionCase
): Promise<RequisitionCase> {
  return request(identity, `/api/requisitions/${row.reference}/submit`, {
    method: "POST",
    body: JSON.stringify({ generation: row.generation })
  });
}

export function reviewRequisition(
  identity: DemoIdentity,
  row: RequisitionCase,
  decision: ReviewDecision,
  reason: string
): Promise<RequisitionCase> {
  return request(identity, `/api/requisitions/${row.reference}/review`, {
    method: "POST",
    body: JSON.stringify({ generation: row.generation, decision, reason })
  });
}

export function resubmitRequisition(
  identity: DemoIdentity,
  row: RequisitionCase,
  fields: RequisitionFields
): Promise<RequisitionCase> {
  return request(identity, `/api/requisitions/${row.reference}/resubmit`, {
    method: "POST",
    body: JSON.stringify({ generation: row.generation, fields })
  });
}

export interface AdvertDraft {
  questions: Array<{ prompt: string; expected: string }>;
  skills: Array<{ keyword: string; weight: number; targetYears: number }>;
}

export function publishAdvert(
  identity: DemoIdentity,
  row: RequisitionCase,
  advert: AdvertDraft
): Promise<RequisitionCase> {
  return request(identity, `/api/requisitions/${row.reference}/advert`, {
    method: "POST",
    body: JSON.stringify({ generation: row.generation, ...advert })
  });
}

export function listApplications(identity: DemoIdentity, reference: number): Promise<ApplicationRecord[]> {
  return request(identity, `/api/requisitions/${reference}/applications`);
}

export function listOpenAdverts(identity: DemoIdentity): Promise<OpenAdvert[]> {
  return request(identity, "/api/adverts");
}

export function applyToAdvert(
  identity: DemoIdentity,
  reference: number,
  submission: ApplicationSubmission
): Promise<ApplicationAcknowledgement> {
  return request(identity, `/api/adverts/${reference}/applications`, {
    method: "POST",
    body: JSON.stringify(submission)
  });
}

export function reviewApplication(
  identity: DemoIdentity,
  record: ApplicationRecord,
  review: { disposition: Disposition; reason: string; note: string }
): Promise<ApplicationReview> {
  return request(identity, `/api/requisitions/${record.reference}/applications/${record.applicationId}/review`, {
    method: "POST",
    body: JSON.stringify(review)
  });
}

export function eraseApplication(identity: DemoIdentity, record: ApplicationRecord, reason: string): Promise<void> {
  return request(identity, `/api/requisitions/${record.reference}/applications/${record.applicationId}/erase`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

export function withdrawApplication(identity: DemoIdentity, reference: number): Promise<void> {
  return request(identity, `/api/adverts/${reference}/applications/mine`, { method: "DELETE" });
}

export function hireApplication(
  identity: DemoIdentity,
  record: ApplicationRecord,
  hire: { legalName: string; startDate: string }
): Promise<EmployeeRecord> {
  return request(identity, `/api/requisitions/${record.reference}/applications/${record.applicationId}/hire`, {
    method: "POST",
    body: JSON.stringify(hire)
  });
}

export function listPeople(identity: DemoIdentity): Promise<EmployeeRecord[]> {
  return request(identity, "/api/people");
}
