// Loads a billing-code list (CPT or HCPCS) into the database.
//
//   parseCodeFile()  read + validate a text/CSV file         (no database)
//   planImport()     work out what WOULD change              (no database writes)
//   applyImport()    make the change, all-or-nothing         (one transaction)
//
// Designed so the licensed file can be loaded without anyone needing to share
// its contents: by default nothing here prints description text.

const fs = require('node:fs');
const { parse } = require('csv-parse/sync');
const { classifyCode } = require('./codeFormat');

class ImportError extends Error {}

const DELIMITER_WORDS = { comma: ',', tab: '\t', pipe: '|', semicolon: ';' };
const ENCODINGS = new Set(['utf8', 'latin1', 'utf16le']);

const CODE_ALIASES = ['code', 'cpt', 'cpt code', 'cptcode', 'hcpc', 'hcpcs', 'hcpcs code', 'procedure code'];
const DESC_ALIASES = ['description', 'long description', 'longdescription', 'long desc', 'long descriptor',
  'descriptor', 'desc', 'procedure description'];

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
const cleanText = (s) => String(s == null ? '' : s).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();

function resolveDelimiter(d) {
  if (d == null) return ',';
  const word = DELIMITER_WORDS[String(d).toLowerCase()];
  if (word) return word;
  if (String(d).length === 1) return String(d);
  throw new ImportError(`Unrecognized delimiter "${d}". Use comma, tab, pipe, semicolon, or a single character.`);
}

function parseFixedSpec(spec) {
  // "code:1-5,description:12-91"  (1-based, inclusive column positions)
  const out = {};
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(code|description):(\d+)-(\d+)$/i);
    if (!m) throw new ImportError(`Could not read the fixed-width layout "${spec}". Expected something like code:1-5,description:12-91`);
    const a = Number(m[2]), b = Number(m[3]);
    if (a < 1 || b < a) throw new ImportError(`Fixed-width range ${m[2]}-${m[3]} is not valid.`);
    out[m[1].toLowerCase()] = [a, b];
  }
  if (!out.code || !out.description) throw new ImportError('The fixed-width layout needs both a code range and a description range.');
  return out;
}

function readFileText(file, encoding = 'utf8') {
  if (!ENCODINGS.has(encoding)) throw new ImportError(`Unsupported encoding "${encoding}". Use utf8, latin1, or utf16le.`);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    throw new ImportError(`Could not open the file "${file}". Check the path and try again.`);
  }
  // A byte-order mark tells us the real encoding, whatever --encoding says. This
  // rescues the common mistake of reading a UTF-8 file with --encoding latin1.
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  return buf.toString(encoding).replace(/^\uFEFF/, '');
}

function resolveColumn(spec, header, aliases, label) {
  if (spec != null && spec !== '') {
    if (/^\d+$/.test(String(spec))) {
      const idx = Number(spec) - 1;
      if (idx < 0 || idx >= header.length) throw new ImportError(`Column number ${spec} does not exist (the file has ${header.length} columns).`);
      return idx;
    }
    const idx = header.indexOf(norm(spec));
    if (idx === -1) throw new ImportError(`Column "${spec}" was not found. Columns in this file: ${header.join(' | ')}`);
    return idx;
  }
  const idx = header.findIndex(h => aliases.includes(h));
  if (idx === -1) {
    throw new ImportError(`Could not tell which column holds the ${label}. Columns in this file: ${header.join(' | ')}. ` +
      `Tell the importer with --${label === 'code' ? 'code' : 'desc'}-col.`);
  }
  return idx;
}

/**
 * Read and validate a code file. Never touches the database.
 * Returns { rows, problems, stats, columnsFound }.
 */
function parseCodeFile(text, options = {}) {
  const opts = { delimiter: ',', quotes: true, duplicates: 'error', set: 'AUTO', ...options };
  if (opts.hasHeader === undefined) opts.hasHeader = !opts.fixed;
  if (!['error', 'merge', 'last'].includes(opts.duplicates)) throw new ImportError('--duplicates must be error, merge, or last.');
  if (!['CPT', 'HCPCS', 'AUTO'].includes(opts.set)) throw new ImportError('--set must be CPT, HCPCS, or AUTO.');
  text = String(text).replace(/^\uFEFF/, '');

  const records = []; // { line, code, description }
  let columnsFound = null;

  if (opts.fixed) {
    const spec = parseFixedSpec(opts.fixed);
    let skippedHeader = !opts.hasHeader;
    text.split(/\r?\n/).forEach((ln, i) => {
      if (!ln.trim()) return;
      if (!skippedHeader) { skippedHeader = true; return; }
      records.push({
        line: i + 1,
        code: cleanText(ln.slice(spec.code[0] - 1, spec.code[1])).toUpperCase(),
        description: cleanText(ln.slice(spec.description[0] - 1, spec.description[1])),
      });
    });
  } else {
    let rows;
    try {
      rows = parse(text, {
        delimiter: resolveDelimiter(opts.delimiter), quote: opts.quotes ? '"' : false,
        relax_quotes: true, relax_column_count: true, skip_empty_lines: true, info: true, bom: true,
      });
    } catch (e) {
      if (e instanceof ImportError) throw e;
      // Deliberately does not echo e.message: it can quote text from the file.
      throw new ImportError(`The file could not be read as delimited text (${e.code || 'parse error'}` +
        `${e.lines ? ' near line ' + e.lines : ''}). Check --delimiter, and try --no-quotes if descriptions contain stray quote marks.`);
    }
    if (rows.length === 0) throw new ImportError('The file is empty.');

    let codeIdx, descIdx, start = 0;
    if (opts.hasHeader) {
      const headerRaw = rows[0].record.map(c => String(c).trim());
      const header = headerRaw.map(norm);
      columnsFound = headerRaw;
      codeIdx = resolveColumn(opts.codeCol, header, CODE_ALIASES, 'code');
      descIdx = resolveColumn(opts.descCol, header, DESC_ALIASES, 'description');
      start = 1;
    } else {
      const n = rows[0].record.length;
      codeIdx = resolveColumn(opts.codeCol == null ? '1' : opts.codeCol, new Array(n).fill(''), [], 'code');
      descIdx = resolveColumn(opts.descCol == null ? '2' : opts.descCol, new Array(n).fill(''), [], 'description');
    }
    for (const { record, info } of rows.slice(start)) {
      records.push({ line: info.lines, code: cleanText(record[codeIdx]).toUpperCase(), description: cleanText(record[descIdx]) });
    }
  }

  // ---- validate ----
  const problems = [];
  const out = [];
  const seen = new Map(); // code -> index in out
  let rowsRead = 0;
  for (const rec of records) {
    if (!rec.code && !rec.description) continue; // blank row
    rowsRead++;
    const kind = classifyCode(rec.code);
    if (!rec.code || !kind) { problems.push({ line: rec.line, reason: 'invalid_code', code: rec.code.slice(0, 12) }); continue; }
    if (opts.set !== 'AUTO' && kind !== opts.set) { problems.push({ line: rec.line, reason: 'wrong_set', code: rec.code }); continue; }
    if (!rec.description) { problems.push({ line: rec.line, reason: 'empty_description', code: rec.code }); continue; }

    if (seen.has(rec.code)) {
      const at = seen.get(rec.code);
      if (opts.duplicates === 'merge') { out[at].description += ' ' + rec.description; continue; }
      if (opts.duplicates === 'last') { out[at] = { code: rec.code, set: kind, description: rec.description, line: rec.line }; continue; }
      problems.push({ line: rec.line, reason: 'duplicate_code', code: rec.code });
      continue;
    }
    seen.set(rec.code, out.length);
    out.push({ code: rec.code, set: kind, description: rec.description, line: rec.line });
  }

  const lens = out.map(r => r.description.length).sort((a, b) => a - b);
  const stats = {
    rowsRead,
    valid: out.length,
    bySet: out.reduce((acc, r) => { acc[r.set] = (acc[r.set] || 0) + 1; return acc; }, {}),
    problemCounts: problems.reduce((acc, p) => { acc[p.reason] = (acc[p.reason] || 0) + 1; return acc; }, {}),
    descriptionLength: lens.length ? { min: lens[0], median: lens[Math.floor(lens.length / 2)], max: lens[lens.length - 1] } : null,
  };
  return { rows: out, problems, stats, columnsFound };
}

// ---------------------------------------------------------------------------

async function loadExisting(db, sets) {
  const { rows } = await db.query(
    `SELECT code, code_set, description, status FROM code_reference WHERE code_set = ANY($1::text[])`, [sets]);
  return new Map(rows.map(r => [r.code, { code_set: r.code_set, description: r.description, status: r.status }]));
}

/**
 * Work out what an import WOULD do. Pure function: no database access.
 *   existing: Map(code -> { code_set, description, status })
 *   mode:     'replace' (a full yearly file: codes missing from it get retired)
 *             'add'     (a supplement: only add/update, never retire)
 */
function planImport({ existing, rows, mode = 'replace', force = false }) {
  if (!['replace', 'add'].includes(mode)) throw new ImportError('--mode must be replace or add.');
  const setsInFile = [...new Set(rows.map(r => r.set))];
  const inFile = new Set(rows.map(r => r.code));

  const adds = [], updates = [], reactivates = [];
  let unchanged = 0;
  for (const r of rows) {
    const cur = existing.get(r.code);
    if (!cur) adds.push(r);
    else if (cur.status === 'retired') reactivates.push(r);
    else if (cur.description !== r.description || cur.code_set !== r.set) updates.push(r);
    else unchanged++;
  }

  const retires = [];
  let blocked = null;
  if (mode === 'replace') {
    for (const [code, cur] of existing) {
      if (cur.status === 'active' && setsInFile.includes(cur.code_set) && !inFile.has(code)) retires.push(code);
    }
    // Safety net: a partial or wrong file must not quietly retire most of the live list.
    for (const set of setsInFile) {
      const activeBefore = [...existing.values()].filter(c => c.code_set === set && c.status === 'active').length;
      const inThisFile = rows.filter(r => r.set === set).length;
      if (!force && activeBefore >= 10 && inThisFile < activeBefore * 0.5) {
        blocked = `This file has only ${inThisFile} ${set} codes, but the database currently has ${activeBefore} active ones. ` +
          `Importing it would retire ${retires.length} codes. That looks like a partial or wrong file, so nothing was changed. ` +
          `If you are sure, run it again with --force.`;
      }
    }
  }
  return { adds, updates, reactivates, unchanged, retires, setsInFile, blocked };
}

/** Make the change in ONE transaction: either everything is imported, or nothing is. */
async function applyImport(pool, plan, meta) {
  if (plan.blocked) throw new ImportError(plan.blocked);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const toWrite = [...plan.adds, ...plan.updates, ...plan.reactivates];
    for (let i = 0; i < toWrite.length; i += 2000) {
      const chunk = toWrite.slice(i, i + 2000);
      await client.query(
        `INSERT INTO code_reference (code, code_set, description, status, source_label, imported_at, retired_at, retired_source)
         SELECT t.code, t.code_set, t.description, 'active', $4, now(), NULL, NULL
           FROM unnest($1::text[], $2::text[], $3::text[]) AS t(code, code_set, description)
         ON CONFLICT (code) DO UPDATE
            SET code_set = EXCLUDED.code_set, description = EXCLUDED.description, status = 'active',
                source_label = EXCLUDED.source_label, imported_at = now(), retired_at = NULL, retired_source = NULL`,
        [chunk.map(r => r.code), chunk.map(r => r.set), chunk.map(r => r.description), meta.sourceLabel]);
    }
    for (let i = 0; i < plan.retires.length; i += 2000) {
      await client.query(
        `UPDATE code_reference SET status = 'retired', retired_at = now(), retired_source = $2
          WHERE code = ANY($1::text[]) AND status = 'active'`,
        [plan.retires.slice(i, i + 2000), meta.sourceLabel]);
    }

    const { rows } = await client.query(
      `INSERT INTO code_imports (code_set, mode, source_label, file_name, rows_read, added, updated, unchanged, reactivated, retired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [plan.setsInFile.join('+'), meta.mode, meta.sourceLabel, meta.fileName || null, meta.rowsRead,
       plan.adds.length, plan.updates.length, plan.unchanged, plan.reactivates.length, plan.retires.length]);

    await client.query('COMMIT');
    return { importId: rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ImportError, parseCodeFile, readFileText, loadExisting, planImport, applyImport, ENCODINGS };
