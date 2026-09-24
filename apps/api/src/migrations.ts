import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-slice-1-schema",
    sql: `
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
    `
  },
  {
    version: 2,
    name: "tenant-ownership-and-idempotency",
    sql: `
      ALTER TABLE requisitions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'demo';
      ALTER TABLE requisitions ADD COLUMN requester_id TEXT NOT NULL DEFAULT 'legacy-requester';
      UPDATE requisitions
        SET requester_id = COALESCE(
          (SELECT actor FROM audit_entries
            WHERE audit_entries.reference = requisitions.reference
              AND audit_entries.event = 'draft-created'
            ORDER BY ordinal
            LIMIT 1),
          requester_id
        );

      CREATE INDEX requisitions_tenant_reference
        ON requisitions (tenant_id, reference);
      CREATE INDEX requisitions_tenant_requester
        ON requisitions (tenant_id, requester_id, reference DESC);

      CREATE TABLE reference_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_reference INTEGER NOT NULL CHECK (next_reference > 0)
      );
      INSERT OR IGNORE INTO reference_sequence (singleton, next_reference)
        SELECT 1, COALESCE(MAX(reference), 0) + 1 FROM requisitions;

      CREATE TABLE idempotency_records (
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, actor, idempotency_key)
      );
    `
  },
  {
    version: 3,
    name: "retire-command-sourcing",
    sql: `
      ALTER TABLE command_log RENAME TO legacy_command_log;
    `
  }
];

export function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = database.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const versions = new Set(applied.map(({ version }) => Number(version)));

  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      const alreadyApplied = database
        .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { present: number } | undefined;
      if (alreadyApplied !== undefined) {
        database.exec("COMMIT");
        continue;
      }
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, Date.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
