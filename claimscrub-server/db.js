const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }, // Render's managed Postgres requires SSL
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_emails (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

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

  // Reports older than this are just abandoned/incomplete sessions — safe to
  // let them expire. Adjust retention to match whatever your finalized
  // Privacy Policy commits to.
  console.log('Database schema ready.');
}

module.exports = { pool, initSchema };
