const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }, // Render's managed Postgres requires SSL
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id UUID PRIMARY KEY,
      items JSONB NOT NULL,
      summary JSONB NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT false,
      stripe_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );
  `);

  // Added for payment tracing. "IF NOT EXISTS" makes this safe to run on every
  // start, including against a database created by an earlier version.
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;`);

  // Billing-code lists, loaded with scripts/import-codes.js. Retired codes are kept
  // (not deleted) so an older bill using a since-retired code isn't treated as unknown.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS code_reference (
      code TEXT PRIMARY KEY,
      code_set TEXT NOT NULL CHECK (code_set IN ('CPT', 'HCPCS')),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      source_label TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      retired_at TIMESTAMPTZ,
      retired_source TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS code_imports (
      id SERIAL PRIMARY KEY,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      code_set TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_label TEXT NOT NULL,
      file_name TEXT,
      rows_read INT NOT NULL,
      added INT NOT NULL, updated INT NOT NULL, unchanged INT NOT NULL,
      reactivated INT NOT NULL, retired INT NOT NULL
    );
  `);

  // Note: reports are only ever created when likely errors were found, so this
  // table holds bill line items. Set a retention/cleanup policy that matches
  // whatever your finalized Privacy Policy commits to.
  console.log('Database schema ready.');
}

module.exports = { pool, initSchema };
