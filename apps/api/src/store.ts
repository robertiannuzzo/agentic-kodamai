import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  AuditEntry,
  RequisitionCase,
  WorkflowCommand,
  WorkflowResult
} from "../../../packages/contracts/src/index.js";

export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StoreError";
  }
}

function sameAudit(left: AuditEntry, right: AuditEntry): boolean {
  return (
    left.event === right.event &&
    left.actor === right.actor &&
    left.tick === right.tick &&
    left.reference === right.reference &&
    left.revision === right.revision &&
    left.detail === right.detail
  );
}

export class RecruitmentStore {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS command_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requisitions (
        reference INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        stage TEXT NOT NULL,
        role TEXT NOT NULL,
        department TEXT NOT NULL,
        headcount INTEGER NOT NULL,
        budget_minor INTEGER NOT NULL,
        justification TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_entries (
        reference INTEGER NOT NULL REFERENCES requisitions(reference),
        ordinal INTEGER NOT NULL,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        tick INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY (reference, ordinal)
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  commands(): WorkflowCommand[] {
    const rows = this.database.prepare("SELECT payload FROM command_log ORDER BY sequence").all() as Array<{
      payload: string;
    }>;
    return rows.map(({ payload }) => JSON.parse(payload) as WorkflowCommand);
  }

  list(): RequisitionCase[] {
    const rows = this.database.prepare("SELECT * FROM requisitions ORDER BY reference DESC").all();
    return rows.map((row) => this.rowToCase(row as Record<string, unknown>));
  }

  get(reference: number): RequisitionCase | null {
    const row = this.database
      .prepare("SELECT * FROM requisitions WHERE reference = ?")
      .get(reference) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.rowToCase(row);
  }

  private history(reference: number): AuditEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM audit_entries WHERE reference = ? ORDER BY ordinal")
      .all(reference) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      event: String(row.event),
      actor: String(row.actor),
      tick: Number(row.tick),
      reference,
      revision: Number(row.revision),
      detail: String(row.detail)
    }));
  }

  private rowToCase(row: Record<string, unknown>): RequisitionCase {
    const reference = Number(row.reference);
    return {
      reference,
      generation: Number(row.generation),
      revision: Number(row.revision),
      stage: String(row.stage) as RequisitionCase["stage"],
      role: String(row.role),
      department: String(row.department),
      headcount: Number(row.headcount),
      budgetMinor: Number(row.budget_minor),
      justification: String(row.justification),
      history: this.history(reference)
    };
  }

  commit(command: WorkflowCommand, result: RequisitionCase): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.get(result.reference);
      if (command.kind === "create-draft") {
        if (existing !== null || result.generation !== 0) throw new StoreError("stale-version");
        this.database
          .prepare(`INSERT INTO requisitions
            (reference, generation, revision, stage, role, department, headcount, budget_minor,
             justification, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            result.reference,
            result.generation,
            result.revision,
            result.stage,
            result.role,
            result.department,
            result.headcount,
            result.budgetMinor,
            result.justification,
            Date.now()
          );
      } else {
        if (existing === null || existing.generation !== command.generation) {
          throw new StoreError("stale-version");
        }
        const update = this.database
          .prepare(`UPDATE requisitions SET generation = ?, revision = ?, stage = ?, role = ?,
            department = ?, headcount = ?, budget_minor = ?, justification = ?, updated_at = ?
            WHERE reference = ? AND generation = ?`)
          .run(
            result.generation,
            result.revision,
            result.stage,
            result.role,
            result.department,
            result.headcount,
            result.budgetMinor,
            result.justification,
            Date.now(),
            result.reference,
            command.generation
          );
        if (Number(update.changes) !== 1) throw new StoreError("stale-version");
      }

      const persistedHistory = existing?.history ?? [];
      if (
        persistedHistory.length > result.history.length ||
        persistedHistory.some((entry, index) => !sameAudit(entry, result.history[index] as AuditEntry))
      ) {
        throw new StoreError("audit-history-mismatch");
      }

      const insertAudit = this.database.prepare(`INSERT INTO audit_entries
        (reference, ordinal, event, actor, tick, revision, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      result.history.slice(persistedHistory.length).forEach((entry, offset) => {
        insertAudit.run(
          result.reference,
          persistedHistory.length + offset,
          entry.event,
          entry.actor,
          entry.tick,
          entry.revision,
          entry.detail
        );
      });

      this.database.prepare("INSERT INTO command_log (payload) VALUES (?)").run(JSON.stringify(command));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  validateProjection(replayed: WorkflowResult): void {
    const persisted = this.list().sort((a, b) => a.reference - b.reference);
    const reconstructed = [...replayed.cases].sort((a, b) => a.reference - b.reference);
    if (!isDeepStrictEqual(persisted, reconstructed)) {
      throw new StoreError("persisted-projection-does-not-match-idris-replay");
    }
  }
}
