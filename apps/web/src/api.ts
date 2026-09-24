import type {
  ApiError,
  DemoRole,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision
} from "../../../packages/contracts/src/index";

export interface DemoIdentity {
  actor: string;
  role: DemoRole;
}

async function request<T>(
  identity: DemoIdentity,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-demo-actor": identity.actor,
      "x-demo-role": identity.role,
      ...init.headers
    }
  });
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
