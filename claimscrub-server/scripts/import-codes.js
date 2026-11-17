#!/usr/bin/env node
// Load a billing-code list (CPT or HCPCS) into the database.
//
//   Preview (changes nothing):  node scripts/import-codes.js --file codes.csv --set CPT
//   Import for real:            node scripts/import-codes.js --file codes.csv --set CPT --source "AMA CPT 2027" --apply
//
// Run with --help for every option. By default NOTHING from the file's description
// text is printed, so the output can be shared safely when asking for help.

require('dotenv').config();
const { parseArgs } = require('node:util');
const path = require('node:path');
const codeImport = require('../codeImport');
const { ImportError } = codeImport;

const HELP = `
ClaimScrub code importer

USAGE
  node scripts/import-codes.js --file <path> --set <CPT|HCPCS|AUTO> [options]

By default this only PREVIEWS what would happen. Nothing is changed until you add --apply.

REQUIRED
  --file <path>          the file to load
  --set <CPT|HCPCS|AUTO> which kind of codes the file holds (AUTO = decide per row)
  --source "<label>"     a name for this import, e.g. "AMA CPT 2027" (required with --apply)

HOW TO READ THE FILE
  --delimiter <x>        comma (default), tab, pipe, semicolon, or a single character
  --fixed "<layout>"     for fixed-width files, e.g. "code:1-5,description:12-91"
  --has-header <yes|no>  does the first row hold column names? (default yes; no for --fixed)
  --code-col <name|n>    which column holds the code (name, or 1-based number)
  --desc-col <name|n>    which column holds the description
  --encoding <e>         utf8 (default), latin1, or utf16le
  --no-quotes            treat quote marks as ordinary characters
  --duplicates <how>     if a code appears twice: error (default), merge (join the
                         descriptions, for files that split long text over rows), or last

HOW TO APPLY IT
  --mode <replace|add>   replace (default): a full yearly file; codes missing from it are
                         marked retired. add: only add/update, never retire.
  --skip-invalid         import the valid rows even if some rows are invalid
  --force                allow a file that would retire more than half the current list
  --apply                actually make the change

OUTPUT
  --show-text            also print the (truncated) description text. Off by default.
`;

const OPTIONS = {
  file: { type: 'string' }, set: { type: 'string' }, source: { type: 'string' },
  delimiter: { type: 'string' }, fixed: { type: 'string' }, 'has-header': { type: 'string' },
  'code-col': { type: 'string' }, 'desc-col': { type: 'string' }, encoding: { type: 'string' },
  'no-quotes': { type: 'boolean' }, duplicates: { type: 'string' }, mode: { type: 'string' },
  'skip-invalid': { type: 'boolean' }, force: { type: 'boolean' }, apply: { type: 'boolean' },
  'show-text': { type: 'boolean' }, help: { type: 'boolean' },
};

const REASONS = {
  invalid_code: 'row does not start with a recognizable code',
  wrong_set: 'code is the wrong kind for --set',
  empty_description: 'code has no description',
  duplicate_code: 'code appears more than once',
};

async function run(argv, io = { log: console.log, error: console.error }) {
  const out = (...a) => io.log(...a);
  let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false })); }
  catch (e) { io.error(`Problem with the options: ${e.message}\nRun with --help to see them.`); return 1; }

  if (values.help) { out(HELP); return 0; }
  if (!values.file || !values.set) { io.error('You need at least --file and --set. Run with --help to see everything.'); return 1; }
  const set = values.set.toUpperCase();
  if (values.apply && !values.source) { io.error('Add --source "a name for this import" (for example "AMA CPT 2027") when using --apply.'); return 1; }

  let parsed;
  try {
    const text = codeImport.readFileText(values.file, values.encoding || 'utf8');
    parsed = codeImport.parseCodeFile(text, {
      set, delimiter: values.delimiter, fixed: values.fixed,
      hasHeader: values['has-header'] == null ? undefined : !/^(no|false|0)$/i.test(values['has-header']),
      codeCol: values['code-col'], descCol: values['desc-col'],
      quotes: !values['no-quotes'], duplicates: values.duplicates || 'error',
    });
  } catch (e) {
    if (e instanceof ImportError) { io.error(`\n${e.message}`); return 1; }
    throw e;
  }

  const { rows, problems, stats, columnsFound } = parsed;
  out(`\nFILE: ${path.basename(values.file)}`);
  if (columnsFound) out(`Columns found: ${columnsFound.join(' | ')}`);
  out(`Rows read: ${stats.rowsRead}   Valid codes: ${stats.valid}   ` +
      `(${Object.entries(stats.bySet).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})`);
  if (stats.descriptionLength) {
    const d = stats.descriptionLength;
    out(`Description length (characters): shortest ${d.min}, typical ${d.median}, longest ${d.max}`);
  }
  out('\nFirst rows as read:');
  for (const r of rows.slice(0, 3)) {
    out(`  ${r.code}  ${values['show-text'] ? '"' + r.description.slice(0, 60) + (r.description.length > 60 ? '...' : '') + '"' : `[description: ${r.description.length} characters]`}`);
  }
  if (problems.length) {
    out(`\nPROBLEMS: ${problems.length} row(s) could not be used`);
    for (const [reason, n] of Object.entries(stats.problemCounts)) out(`  ${n} x ${REASONS[reason] || reason}`);
    out('  Examples (line numbers): ' + problems.slice(0, 5).map(p => `line ${p.line}${p.code ? ' (' + p.code + ')' : ''}`).join(', '));
  } else {
    out('\nNo problems found in the file.');
  }

  if (!process.env.DATABASE_URL) {
    out('\n(DATABASE_URL is not set, so the comparison with the database was skipped.)');
    if (values.apply) { io.error('Cannot --apply without DATABASE_URL.'); return 1; }
    return problems.length ? 1 : 0;
  }

  // run() leaves the shared database connection open (other code may still be using
  // it). The command-line entry point at the bottom closes it when finished.
  const { pool, initSchema } = require('../db');
  {
    await initSchema();
    if (!rows.length) { io.error('\nNo valid codes to import.'); return 1; }
    const sets = [...new Set(rows.map(r => r.set))];
    const existing = await codeImport.loadExisting(pool, sets);
    const mode = values.mode || 'replace';
    let plan;
    try { plan = codeImport.planImport({ existing, rows, mode, force: !!values.force }); }
    catch (e) { if (e instanceof ImportError) { io.error(`\n${e.message}`); return 1; } throw e; }

    out(`\nWHAT WOULD CHANGE (mode: ${mode})`);
    out(`  New codes:            ${plan.adds.length}`);
    out(`  Descriptions changed: ${plan.updates.length}`);
    out(`  Brought back:         ${plan.reactivates.length}  (were retired, are in this file)`);
    out(`  Unchanged:            ${plan.unchanged}`);
    out(`  Marked retired:       ${plan.retires.length}  (in the database, not in this file)`);

    if (plan.blocked) { io.error(`\nSTOPPED: ${plan.blocked}`); return 1; }
    if (problems.length && !values['skip-invalid'] && values.apply) {
      io.error('\nNothing was imported, because some rows had problems. Fix the file, or add --skip-invalid to import only the valid rows.');
      return 1;
    }
    if (!values.apply) {
      out('\nNo changes made. This was only a preview. Add --apply (and --source) to import.');
      return problems.length ? 1 : 0;
    }

    const { importId } = await codeImport.applyImport(pool, plan, {
      sourceLabel: values.source, mode, fileName: path.basename(values.file), rowsRead: stats.rowsRead,
    });
    out(`\nDONE. Import #${importId} saved. The live site picks it up within about 30 seconds.`);
    return 0;
  }
}

module.exports = { run };

if (require.main === module) {
  const closeDb = async () => { if (process.env.DATABASE_URL) await require('../db').pool.end().catch(() => {}); };
  run(process.argv.slice(2))
    .then(async code => { await closeDb(); process.exit(code); })
    .catch(async err => { console.error('\nUnexpected error:', err.message); await closeDb(); process.exit(1); });
}
