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
  },
  {
    version: 5,
    name: "reviews-erasure-and-privacy-notice",
    sql: `
      -- Recruitment relies on steps before a contract, not consent: record that
      -- the privacy notice was acknowledged.
      ALTER TABLE applications RENAME COLUMN consented_at TO notice_acknowledged_at;
      ALTER TABLE applications ADD COLUMN erased_at INTEGER;
      ALTER TABLE applications ADD COLUMN erasure_reason TEXT;
      CREATE INDEX applications_retention ON applications (erased_at, created_at);

      CREATE TABLE application_reviews (
        reference INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('shortlist', 'reject')),
        reason TEXT NOT NULL,
        note TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        tick INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (reference, application_id),
        FOREIGN KEY (reference, application_id) REFERENCES applications(reference, application_id)
      );

      -- Scores and evidence stay immutable. The only permitted change is one
      -- erasure: personal fields are cleared and erased_at is set, once.
      DROP TRIGGER applications_immutable_update;
      CREATE TRIGGER applications_erasure_only BEFORE UPDATE ON applications
        WHEN OLD.erased_at IS NOT NULL
          OR NEW.erased_at IS NULL
          OR NEW.erasure_reason IS NULL
          OR NEW.candidate_name <> 'Erased candidate'
          OR NEW.cv_text <> ''
          OR NEW.cv_version <> 'erased'
          OR NEW.candidate_actor NOT LIKE 'erased:%'
          OR NEW.reference IS NOT OLD.reference
          OR NEW.application_id IS NOT OLD.application_id
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.cv_locator IS NOT OLD.cv_locator
          OR NEW.notice_acknowledged_at IS NOT OLD.notice_acknowledged_at
          OR NEW.keywords IS NOT OLD.keywords
          OR NEW.experience IS NOT OLD.experience
          OR NEW.screening IS NOT OLD.screening
          OR NEW.completeness IS NOT OLD.completeness
          OR NEW.total IS NOT OLD.total
          OR NEW.policy_version IS NOT OLD.policy_version
          OR NEW.evidence_actor IS NOT OLD.evidence_actor
          OR NEW.evidence_tick IS NOT OLD.evidence_tick
          OR NEW.evidence_revision IS NOT OLD.evidence_revision
          OR NEW.evidence_detail IS NOT OLD.evidence_detail
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;

      DROP TRIGGER application_answers_immutable_update;
      CREATE TRIGGER application_answers_erasure_only BEFORE UPDATE ON application_answers
        WHEN NEW.answer <> ''
          OR NEW.question_id IS NOT OLD.question_id
          OR NEW.ordinal IS NOT OLD.ordinal
          OR (SELECT erased_at FROM applications
              WHERE applications.reference = OLD.reference
                AND applications.application_id = OLD.application_id) IS NULL
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;

      CREATE TRIGGER application_reviews_erasure_only BEFORE UPDATE ON application_reviews
        WHEN NEW.reason <> '' OR NEW.note <> ''
          OR NEW.disposition IS NOT OLD.disposition
          OR NEW.reviewer IS NOT OLD.reviewer
          OR NEW.tick IS NOT OLD.tick
          OR NEW.detail IS NOT OLD.detail
          OR (SELECT erased_at FROM applications
              WHERE applications.reference = OLD.reference
                AND applications.application_id = OLD.application_id) IS NULL
        BEGIN SELECT RAISE(ABORT, 'review-immutable'); END;
      CREATE TRIGGER application_reviews_immutable_delete BEFORE DELETE ON application_reviews
        BEGIN SELECT RAISE(ABORT, 'review-immutable'); END;
    `
  },
  {
    version: 6,
    name: "people-records-with-provenance",
    sql: `
      -- The join the design note found missing: a people record that exists
      -- only as the result of hiring one shortlisted application.
      CREATE TABLE employees (
        employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        reference INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        legal_name TEXT NOT NULL,
        start_tick INTEGER NOT NULL,
        hired_by TEXT NOT NULL,
        hired_tick INTEGER NOT NULL,
        evidence_revision INTEGER NOT NULL,
        evidence_detail TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (reference, application_id),
        FOREIGN KEY (reference, application_id) REFERENCES applications(reference, application_id)
      );
      CREATE INDEX employees_tenant ON employees (tenant_id, employee_id);

      CREATE TRIGGER employees_provenance_immutable BEFORE UPDATE ON employees
        WHEN NEW.reference IS NOT OLD.reference
          OR NEW.application_id IS NOT OLD.application_id
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.evidence_detail IS NOT OLD.evidence_detail
          OR NEW.hired_by IS NOT OLD.hired_by
          OR NEW.hired_tick IS NOT OLD.hired_tick
        BEGIN SELECT RAISE(ABORT, 'provenance-immutable'); END;
      CREATE TRIGGER employees_no_delete BEFORE DELETE ON employees
        BEGIN SELECT RAISE(ABORT, 'provenance-immutable'); END;
    `
  },
  {
    version: 7,
    name: "complete-erasure-and-provenance-triggers",
    sql: `
      -- Erasure also pseudonymises the scoring actor, which is the candidate.
      DROP TRIGGER applications_erasure_only;
      CREATE TRIGGER applications_erasure_only BEFORE UPDATE ON applications
        WHEN OLD.erased_at IS NOT NULL
          OR NEW.erased_at IS NULL
          OR NEW.erasure_reason IS NULL
          OR NEW.candidate_name <> 'Erased candidate'
          OR NEW.cv_text <> ''
          OR NEW.cv_version <> 'erased'
          OR NEW.candidate_actor NOT LIKE 'erased:%'
          OR NEW.evidence_actor IS NOT NEW.candidate_actor
          OR NEW.reference IS NOT OLD.reference
          OR NEW.application_id IS NOT OLD.application_id
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.cv_locator IS NOT OLD.cv_locator
          OR NEW.notice_acknowledged_at IS NOT OLD.notice_acknowledged_at
          OR NEW.keywords IS NOT OLD.keywords
          OR NEW.experience IS NOT OLD.experience
          OR NEW.screening IS NOT OLD.screening
          OR NEW.completeness IS NOT OLD.completeness
          OR NEW.total IS NOT OLD.total
          OR NEW.policy_version IS NOT OLD.policy_version
          OR NEW.evidence_tick IS NOT OLD.evidence_tick
          OR NEW.evidence_revision IS NOT OLD.evidence_revision
          OR NEW.evidence_detail IS NOT OLD.evidence_detail
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;

      -- Every review column is fixed; only reason and note may be cleared, and
      -- only once the application itself has been erased.
      DROP TRIGGER application_reviews_erasure_only;
      CREATE TRIGGER application_reviews_erasure_only BEFORE UPDATE ON application_reviews
        WHEN NEW.reason <> '' OR NEW.note <> ''
          OR NEW.reference IS NOT OLD.reference
          OR NEW.application_id IS NOT OLD.application_id
          OR NEW.disposition IS NOT OLD.disposition
          OR NEW.reviewer IS NOT OLD.reviewer
          OR NEW.tick IS NOT OLD.tick
          OR NEW.revision IS NOT OLD.revision
          OR NEW.detail IS NOT OLD.detail
          OR NEW.created_at IS NOT OLD.created_at
          OR (SELECT erased_at FROM applications
              WHERE applications.reference = OLD.reference
                AND applications.application_id = OLD.application_id) IS NULL
        BEGIN SELECT RAISE(ABORT, 'review-immutable'); END;

      -- A people record is a fact: no column may change.
      DROP TRIGGER employees_provenance_immutable;
      CREATE TRIGGER employees_provenance_immutable BEFORE UPDATE ON employees
        BEGIN SELECT RAISE(ABORT, 'provenance-immutable'); END;
    `
  },
  {
    version: 8,
    name: "repair-earlier-erasures",
    sql: `
      -- Rows erased before migration 7 kept the candidate's email as the
      -- scoring actor. Repair them, with the trigger lifted for the backfill.
      DROP TRIGGER applications_erasure_only;
      UPDATE applications SET evidence_actor = candidate_actor
        WHERE erased_at IS NOT NULL AND evidence_actor IS NOT candidate_actor;
      CREATE TRIGGER applications_erasure_only BEFORE UPDATE ON applications
        WHEN OLD.erased_at IS NOT NULL
          OR NEW.erased_at IS NULL
          OR NEW.erasure_reason IS NULL
          OR NEW.candidate_name <> 'Erased candidate'
          OR NEW.cv_text <> ''
          OR NEW.cv_version <> 'erased'
          OR NEW.candidate_actor NOT LIKE 'erased:%'
          OR NEW.evidence_actor IS NOT NEW.candidate_actor
          OR NEW.reference IS NOT OLD.reference
          OR NEW.application_id IS NOT OLD.application_id
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.cv_locator IS NOT OLD.cv_locator
          OR NEW.notice_acknowledged_at IS NOT OLD.notice_acknowledged_at
          OR NEW.keywords IS NOT OLD.keywords
          OR NEW.experience IS NOT OLD.experience
          OR NEW.screening IS NOT OLD.screening
          OR NEW.completeness IS NOT OLD.completeness
          OR NEW.total IS NOT OLD.total
          OR NEW.policy_version IS NOT OLD.policy_version
          OR NEW.evidence_tick IS NOT OLD.evidence_tick
          OR NEW.evidence_revision IS NOT OLD.evidence_revision
          OR NEW.evidence_detail IS NOT OLD.evidence_detail
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'application-immutable'); END;

      -- Cached responses for erased applications can carry the email, the
      -- review reason and note. Retries of those requests are forgotten.
      DELETE FROM idempotency_records WHERE EXISTS (
        SELECT 1 FROM applications
        WHERE applications.erased_at IS NOT NULL
          AND idempotency_records.operation IN (
            'review-application:' || applications.reference || ':' || applications.application_id,
            'hire:' || applications.reference || ':' || applications.application_id
          )
      );
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
