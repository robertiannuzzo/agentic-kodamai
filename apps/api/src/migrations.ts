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
  },
  {
    version: 4,
    name: "frozen-adverts-and-scored-applications",
    sql: `
      CREATE TABLE advert_questions (
        reference INTEGER NOT NULL REFERENCES requisitions(reference),
        ordinal INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        expected TEXT NOT NULL,
        PRIMARY KEY (reference, ordinal)
      );

      CREATE TABLE advert_skills (
        reference INTEGER NOT NULL REFERENCES requisitions(reference),
        ordinal INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        keyword TEXT NOT NULL,
        weight INTEGER NOT NULL,
        target_years INTEGER NOT NULL,
        PRIMARY KEY (reference, ordinal)
      );

      CREATE TABLE application_sequence (
        reference INTEGER PRIMARY KEY REFERENCES requisitions(reference),
        next_id INTEGER NOT NULL CHECK (next_id > 0)
      );

      CREATE TABLE applications (
        reference INTEGER NOT NULL REFERENCES requisitions(reference),
        application_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        candidate_actor TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        cv_locator TEXT NOT NULL,
        cv_version TEXT NOT NULL,
        cv_text TEXT NOT NULL,
        consented_at INTEGER NOT NULL,
        keywords INTEGER NOT NULL,
        experience INTEGER NOT NULL,
        screening INTEGER NOT NULL,
        completeness INTEGER NOT NULL,
        total INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        evidence_actor TEXT NOT NULL,
        evidence_tick INTEGER NOT NULL,
        evidence_revision INTEGER NOT NULL,
        evidence_detail TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (reference, application_id),
        UNIQUE (reference, candidate_actor)
      );

      CREATE TABLE application_answers (
        reference INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        answer TEXT NOT NULL,
        PRIMARY KEY (reference, application_id, ordinal),
        FOREIGN KEY (reference, application_id) REFERENCES applications(reference, application_id)
      );

      CREATE TABLE application_experience (
        reference INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        years INTEGER NOT NULL,
        PRIMARY KEY (reference, application_id, ordinal),
        FOREIGN KEY (reference, application_id) REFERENCES applications(reference, application_id)
      );

      -- Published schemas and scored applications are immutable facts. The Idris
      -- replay detects a changed schema; these triggers refuse the change first.
      CREATE TRIGGER advert_questions_frozen_update BEFORE UPDATE ON advert_questions
        BEGIN SELECT RAISE(ABORT, 'advert-frozen'); END;
      CREATE TRIGGER advert_questions_frozen_delete BEFORE DELETE ON advert_questions
        BEGIN SELECT RAISE(ABORT, 'advert-frozen'); END;
      CREATE TRIGGER advert_skills_frozen_update BEFORE UPDATE ON advert_skills
        BEGIN SELECT RAISE(ABORT, 'advert-frozen'); END;
      CREATE TRIGGER advert_skills_frozen_delete BEFORE DELETE ON advert_skills
        BEGIN SELECT RAISE(ABORT, 'advert-frozen'); END;
      CREATE TRIGGER applications_immutable_update BEFORE UPDATE ON applications
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
      CREATE TRIGGER applications_immutable_delete BEFORE DELETE ON applications
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
      CREATE TRIGGER application_answers_immutable_update BEFORE UPDATE ON application_answers
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
      CREATE TRIGGER application_answers_immutable_delete BEFORE DELETE ON application_answers
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
      CREATE TRIGGER application_experience_immutable_update BEFORE UPDATE ON application_experience
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
      CREATE TRIGGER application_experience_immutable_delete BEFORE DELETE ON application_experience
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;
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
