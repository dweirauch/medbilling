// Where the audit looks up billing codes.
//   1. Codes imported into the database (the licensed data, once you have it).
//   2. The small built-in sample set, but ONLY for a kind of code (CPT vs HCPCS)
//      that has not been imported yet. Importing CPT first therefore doesn't make
//      every letter code (J2405...) "not found" before the free HCPCS file is loaded.
//      Once a kind IS imported, the database is trusted completely.
const { pool } = require('./db');
const { DEMO_CPT_REF } = require('./rulesEngine');
const { classifyCode } = require('./codeFormat');

const demoMap = new Map(Object.entries(DEMO_CPT_REF).map(([code, description]) => [code, { description, status: 'active' }]));
const CHECK_EVERY_MS = 30 * 1000; // picks up a new import within ~30 seconds, no restart needed

let cache = null;
let lastCheck = 0;

function buildReference(rows) {
  const map = new Map();
  const importedSets = new Set();
  for (const r of rows) {
    map.set(r.code, { description: r.description, status: r.status });
    importedSets.add(r.code_set);
  }
  return {
    source: importedSets.size ? 'database' : 'demo',
    importedSets: [...importedSets],
    size: map.size,
    get(code) {
      const hit = map.get(code);
      if (hit) return hit;
      const kind = classifyCode(code);
      if (!kind || importedSets.has(kind)) return undefined;
      return demoMap.get(code);
    },
  };
}

async function getReference() {
  const now = Date.now();
  if (cache && now - lastCheck < CHECK_EVERY_MS) return cache.reference;
  const { rows: v } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS version FROM code_imports`);
  const version = Number(v[0].version);
  lastCheck = now;
  if (cache && cache.version === version) return cache.reference;
  const { rows } = await pool.query(`SELECT code, code_set, description, status FROM code_reference`);
  cache = { version, reference: buildReference(rows) };
  return cache.reference;
}

function resetReferenceCache() { cache = null; lastCheck = 0; }

module.exports = { getReference, resetReferenceCache, buildReference };
