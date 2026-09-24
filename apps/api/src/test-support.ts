import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { DemoRole } from "../../../packages/contracts/src/index.js";
import { createApplication, type Application } from "./server.js";

export interface RunningApplication {
  application: Application;
  origin: string;
}

export async function start(databasePath: string): Promise<RunningApplication> {
  const application = await createApplication({ databasePath });
  await new Promise<void>((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address() as AddressInfo;
  return { application, origin: `http://127.0.0.1:${address.port}` };
}

export async function request(
  running: RunningApplication,
  path: string,
  options: {
    method?: string;
    role?: DemoRole;
    actor?: string;
    tenantId?: string;
    idempotencyKey?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; json: unknown }> {
  const role = options.role ?? "requester";
  const method = options.method ?? "GET";
  const response = await fetch(`${running.origin}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-demo-role": role,
      "x-demo-actor": options.actor ?? `${role}@example.test`,
      "x-demo-tenant": options.tenantId ?? "demo",
      ...(method === "GET"
        ? {}
        : { "idempotency-key": options.idempotencyKey ?? randomUUID() })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  return { status: response.status, json: (await response.json()) as unknown };
}
