// Tests for the billing-code importer and the database-backed code lookup.
// Uses a REAL PostgreSQL database (embedded-postgres) and only made-up codes.
//
// To run:  npm install && npm install --no-save embedded-postgres && npm test

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PG_PORT = 55000 + Math.floor(Math.random() * 900);
let pg, pool, codeImport, refStore, rules, cli, tmpDir;

const csv = (lines) => lines.join('\n') + '\n';
const writeTmp = (name, text, enc = 'utf8') => { const p = path.join(tmpDir, name); fs.writeFileSync(p, Buffer.from(text, enc)); return p; };

async function importText(text, { mode = 'replace', force = false, source = 'test', parse = {} } = {}) {
  const parsed = codeImport.parseCodeFile(text, { set: 'AUTO', ...parse });
  const existing = await codeImport.loadExisting(pool, [...new Set(parsed.rows.map(r => r.set))]);
  const plan = codeImport.planImport({ existing, rows: parsed.rows, mode, force });
  if (plan.blocked) return { parsed, plan };
  await codeImport.applyImport(pool, plan, { sourceLabel: source, mode, fileName: 'x.csv', rowsRead: parsed.stats.rowsRead });
  refStore.resetReferenceCache();
  return { parsed, plan };
}
const row = async (code) => (await pool.query('SELECT * FROM code_reference WHERE code = $1', [code])).rows[0];
const count = async (status) => Number((await pool.query('SELECT count(*) n FROM code_reference WHERE status = $1', [status])).rows[0].n);

async function runCli(args) {
  const lines = [], errs = [];
  const code = await cli.run(args, { log: (...a) => lines.push(a.join(' ')), error: (...a) => errs.push(a.join(' ')) });
  return { code, out: lines.join('\n'), err: errs.join('\n') };
}

describe('billing-code importer', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-import-'));
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    pg = new EmbeddedPostgres({
      // Its own folder, NOT inside the private temp dir: Postgres runs as a separate user.
      databaseDir: path.join(os.tmpdir(), 'claimscrub-import-pg-' + PG_PORT), user: 'postgres', password: 'pw', port: PG_PORT,
      persistent: false, createPostgresUser: process.getuid && process.getuid() === 0,
    });
    await pg.initialise();
    await pg.start();
    process.env.DATABASE_URL = `postgresql://postgres:pw@localhost:${PG_PORT}/postgres`;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

    ({ pool } = require('../db'));
    await require('../db').initSchema();
    codeImport = require('../codeImport');
    refStore = require('../referenceStore');
    rules = require('../rulesEngine');
  });

  after(async () => {
    await pool.end();
    await pg.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE code_reference, code_imports RESTART IDENTITY');
    refStore.resetReferenceCache();
  });

  // ------------------------------------------------------------ reading files
  describe('reading files', () => {
    it('reads a plain CSV with a header, quoted commas, and mixed CPT/HCPCS', () => {
      const r = codeImport.parseCodeFile(csv(['code,description', '00001,alpha', '"00002","bravo, with comma"', 'J0001,drug']));
      assert.equal(r.stats.valid, 3);
      assert.deepEqual(r.stats.bySet, { CPT: 2, HCPCS: 1 });
      assert.equal(r.rows[1].description, 'bravo, with comma');
    });

    it('recognizes common header names and is case/spacing tolerant', () => {
      const r = codeImport.parseCodeFile(csv(['HCPCS_Code\tLong Description\tOther', 'J0001\tdrug one\tx']), { delimiter: 'tab' });
      assert.equal(r.rows[0].code, 'J0001');
      assert.equal(r.rows[0].description, 'drug one');
    });

    it('handles pipe-delimited files with no header and chosen column numbers', () => {
      const r = codeImport.parseCodeFile(csv(['X|00001|alpha', 'X|00002|bravo']), { delimiter: 'pipe', hasHeader: false, codeCol: '2', descCol: '3' });
      assert.equal(r.stats.valid, 2);
      assert.equal(r.rows[1].code, '00002');
    });

    it('handles fixed-width files', () => {
      const r = codeImport.parseCodeFile(csv(['00001      alpha procedure', '0042T      category three code']), { fixed: 'code:1-5,description:12-60' });
      assert.equal(r.stats.valid, 2);
      assert.equal(r.rows[1].code, '0042T');
      assert.equal(r.rows[1].description, 'category three code');
    });

    it('reads latin1 accented text', () => {
      const p = writeTmp('latin.csv', 'code,description\n00001,café procedure\n', 'latin1');
      const r = codeImport.parseCodeFile(codeImport.readFileText(p, 'latin1'));
      assert.equal(r.rows[0].description, 'café procedure');
    });

    it('a UTF-8 file with a byte-order mark reads correctly even if --encoding latin1 is given by mistake', () => {
      const p = writeTmp('bom.csv', '\uFEFFcode,description\n00001,café procedure\n', 'utf8');
      for (const enc of ['utf8', 'latin1']) {
        const r = codeImport.parseCodeFile(codeImport.readFileText(p, enc));
        assert.equal(r.rows[0].code, '00001', enc);
        assert.equal(r.rows[0].description, 'café procedure', enc);
      }
    });

    it('reads UTF-16 files that start with a byte-order mark', () => {
      const p = writeTmp('u16.csv', '\uFEFFcode,description\n00001,alpha\n', 'utf16le');
      const r = codeImport.parseCodeFile(codeImport.readFileText(p));
      assert.equal(r.rows[0].code, '00001');
    });

    it('uppercases codes and collapses whitespace in descriptions', () => {
      const r = codeImport.parseCodeFile(csv(['code,description', ' j0001 ,  drug    with   gaps  ']));
      assert.equal(r.rows[0].code, 'J0001');
      assert.equal(r.rows[0].description, 'drug with gaps');
    });

    it('reports bad rows by line number without dropping the good ones', () => {
      const r = codeImport.parseCodeFile(csv(['code,description', '00001,ok', 'ABCDE,bad code', '00002,', '00001,dup']));
      assert.equal(r.stats.valid, 1);
      assert.deepEqual(r.stats.problemCounts, { invalid_code: 1, empty_description: 1, duplicate_code: 1 });
      assert.deepEqual(r.problems.map(p => p.line), [3, 4, 5]);
    });

    it('rejects codes of the wrong kind when --set is given', () => {
      const r = codeImport.parseCodeFile(csv(['code,description', '00001,cpt', 'J0001,hcpcs']), { set: 'CPT' });
      assert.equal(r.stats.valid, 1);
      assert.equal(r.problems[0].reason, 'wrong_set');
    });

    it('can merge descriptions that are split over several rows, or keep the last', () => {
      const merged = codeImport.parseCodeFile(csv(['code,description', '00001,first part', '00001,second part']), { duplicates: 'merge' });
      assert.equal(merged.rows[0].description, 'first part second part');
      const last = codeImport.parseCodeFile(csv(['code,description', '00001,old', '00001,new']), { duplicates: 'last' });
      assert.equal(last.rows[0].description, 'new');
    });

    it('gives a plain-English error when it cannot find the code column', () => {
      assert.throws(() => codeImport.parseCodeFile(csv(['foo,bar', '00001,x'])), /Could not tell which column holds the code.*foo \| bar/);
    });

    it('never echoes file contents in a parse error', () => {
      const secret = 'SECRET_DESCRIPTION_TEXT';
      try {
        codeImport.parseCodeFile(`code,description\n00001,"${secret}\n`, { quotes: true });
      } catch (e) {
        assert.ok(!String(e.message).includes(secret));
      }
    });
  });

  // ------------------------------------------------------------ applying to the database
  describe('applying to the database', () => {
    it('a first import adds everything and records the import', async () => {
      const { plan } = await importText(csv(['code,description', '00001,a', '00002,b', 'J0001,c']), { source: 'First load' });
      assert.equal(plan.adds.length, 3);
      assert.equal(await count('active'), 3);
      const imp = (await pool.query('SELECT * FROM code_imports')).rows[0];
      assert.equal(imp.source_label, 'First load');
      assert.equal(imp.added, 3);
    });

    it('a yearly replace adds new codes, updates changed text, and RETIRES missing ones (kept, not deleted)', async () => {
      await importText(csv(['code,description', '00001,a', '00002,b', '00003,c']));
      const { plan } = await importText(csv(['code,description', '00001,a', '00002,b changed', '00004,d']), { source: 'Year 2' });
      assert.equal(plan.adds.length, 1);
      assert.equal(plan.updates.length, 1);
      assert.equal(plan.unchanged, 1);
      assert.deepEqual(plan.retires, ['00003']);
      const retired = await row('00003');
      assert.equal(retired.status, 'retired');
      assert.equal(retired.retired_source, 'Year 2');
      assert.equal((await row('00002')).description, 'b changed');
    });

    it('a code that comes back in a later file is reactivated', async () => {
      await importText(csv(['code,description', '00001,a', '00002,b']));
      await importText(csv(['code,description', '00001,a']), { force: true });
      assert.equal((await row('00002')).status, 'retired');
      const { plan } = await importText(csv(['code,description', '00001,a', '00002,b']));
      assert.equal(plan.reactivates.length, 1);
      const back = await row('00002');
      assert.equal(back.status, 'active');
      assert.equal(back.retired_at, null);
    });

    it('a CPT replace never retires HCPCS codes, and vice versa', async () => {
      await importText(csv(['code,description', '00001,a', 'J0001,drug']));
      await importText(csv(['code,description', '00002,b']), { force: true });
      assert.equal((await row('J0001')).status, 'active');
      assert.equal((await row('00001')).status, 'retired');
    });

    it('"add" mode never retires anything', async () => {
      await importText(csv(['code,description', '00001,a', '00002,b']));
      const { plan } = await importText(csv(['code,description', '00003,c']), { mode: 'add' });
      assert.equal(plan.retires.length, 0);
      assert.equal(await count('active'), 3);
    });

    it('SAFETY: a file that would retire more than half the list is blocked unless forced', async () => {
      const big = ['code,description']; for (let i = 1; i <= 20; i++) big.push(String(i).padStart(5, '0') + ',x');
      await importText(csv(big));
      const { plan } = await importText(csv(['code,description', '00001,x', '00002,x']));
      assert.ok(plan.blocked, 'should be blocked');
      assert.equal(await count('active'), 20, 'nothing changed');
      const forced = await importText(csv(['code,description', '00001,x', '00002,x']), { force: true });
      assert.equal(forced.plan.retires.length, 18);
    });

    it('applyImport refuses a blocked plan even if called directly', async () => {
      await assert.rejects(
        codeImport.applyImport(pool, { blocked: 'nope', adds: [], updates: [], reactivates: [], retires: [], setsInFile: [], unchanged: 0 }, { sourceLabel: 'x', mode: 'replace', rowsRead: 0 }),
        /nope/);
    });

    it('ALL-OR-NOTHING: if the import fails halfway, nothing is changed', async () => {
      await importText(csv(['code,description', '00001,original']));
      const parsed = codeImport.parseCodeFile(csv(['code,description', '00001,changed', '00002,new']));
      const plan = codeImport.planImport({ existing: await codeImport.loadExisting(pool, ['CPT']), rows: parsed.rows });
      // sabotage the final bookkeeping step so the transaction must roll back
      const broken = { ...plan, setsInFile: null };
      await assert.rejects(codeImport.applyImport(pool, broken, { sourceLabel: 'x', mode: 'replace', rowsRead: 2 }));
      assert.equal((await row('00001')).description, 'original');
      assert.equal(await row('00002'), undefined);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM code_imports')).rows[0].n), 1);
    });

    it('handles a realistically large file (12,000 codes) quickly', async () => {
      const lines = ['code,description'];
      for (let i = 0; i < 12000; i++) lines.push(String(10000 + i) + ',made-up description number ' + i);
      const t = Date.now();
      const { plan } = await importText(csv(lines));
      assert.equal(plan.adds.length, 12000);
      assert.equal(await count('active'), 12000);
      assert.ok(Date.now() - t < 20000, 'should finish well under 20 seconds');
    });
  });

  // ------------------------------------------------------------ the audit uses it
  describe('the audit uses the imported list', () => {
    it('with nothing imported, the audit uses the built-in sample (same results as before)', async () => {
      const ref = await refStore.getReference();
      assert.equal(ref.source, 'demo');
      const s = rules.summarize(rules.auditItems([{ code: '80053', qty: 1, charge: 1 }, { code: '00001', qty: 1, charge: 2 }], ref));
      assert.equal(s.clearCount, 1, '80053 is in the sample');
      assert.equal(s.yellowCount, 1, '00001 is unknown to the sample');
    });

    it('after a CPT import, imported codes are recognized and CPT codes NOT in it are "not found"', async () => {
      await importText(csv(['code,description', '00001,made-up procedure']));
      const ref = await refStore.getReference();
      assert.equal(ref.source, 'database');
      const res = rules.auditItems([{ code: '00001', qty: 1, charge: 1 }, { code: '99284', qty: 1, charge: 2 }], ref);
      assert.equal(res[0].flags.length, 0);
      assert.equal(res[0].description, 'made-up procedure');
      assert.match(res[1].flags[0].reason, /Code not found/);
    });

    it('importing CPT only does NOT break letter codes: HCPCS still falls back to the sample until imported', async () => {
      await importText(csv(['code,description', '00001,x']));
      let ref = await refStore.getReference();
      assert.ok(ref.get('J2405'), 'J2405 still known from the sample');
      await importText(csv(['code,description', 'J0001,y']), { mode: 'add' });
      ref = await refStore.getReference();
      assert.equal(ref.get('J2405'), undefined, 'once HCPCS is imported, the database is trusted fully');
    });

    it('a retired code is flagged yellow with a plain-English reason', async () => {
      await importText(csv(['code,description', '00001,a', '00002,b']));
      await importText(csv(['code,description', '00001,a']), { force: true });
      const res = rules.auditItems([{ code: '00002', qty: 1, charge: 5 }], await refStore.getReference());
      assert.equal(res[0].flags[0].level, 'yellow');
      assert.match(res[0].flags[0].reason, /retired/);
    });

    it('quantity rules keep working when official descriptions use different wording', async () => {
      await importText(csv(['code,description', '71046,Radiologic examination chest 2 views', '99284,Emergency department visit']));
      const res = rules.auditItems([{ code: '71046', qty: 3, charge: 10 }], await refStore.getReference());
      assert.ok(res[0].flags.some(f => /Quantity of 3/.test(f.reason)), 'still flagged as usually-once');
    });

    it('the live server picks up a new import without restarting (cache refresh)', async () => {
      const first = await refStore.getReference();
      assert.equal(first.source, 'demo');
      await importText(csv(['code,description', '00001,a']));
      const second = await refStore.getReference();
      assert.equal(second.source, 'database');
    });

    it('end to end: POST /api/audit uses the database list', async () => {
      await importText(csv(['code,description', '00001,made-up', '00002,made-up two']));
      const app = require('../app');
      const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/audit`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ code: '00001', qty: 1, charge: 10 }, { code: '00002', qty: 1, charge: 20 }] }),
        });
        const json = await res.json();
        assert.equal(res.status, 200);
        assert.equal(json.free, true, 'both codes recognized, clean bill is free');
      } finally { await new Promise(r => server.close(r)); }
    });
  });

  // ------------------------------------------------------------ the command you run
  describe('the command-line tool', () => {
    before(() => { cli = require('../scripts/import-codes'); });

    it('running the tool leaves the shared database connection usable', async () => {
      const p = writeTmp('pool.csv', csv(['code,description', '00001,a']));
      await runCli(['--file', p, '--set', 'CPT']);
      const r = await pool.query('SELECT 1 AS ok');
      assert.equal(r.rows[0].ok, 1);
    });

    it('preview changes nothing and hides description text by default', async () => {
      const p = writeTmp('p.csv', csv(['code,description', '00001,PRIVATE TEXT HERE']));
      const r = await runCli(['--file', p, '--set', 'CPT']);
      assert.equal(r.code, 0);
      assert.match(r.out, /only a preview/);
      assert.ok(!r.out.includes('PRIVATE TEXT HERE'), 'description text must not be printed by default');
      assert.equal(await count('active'), 0);
    });

    it('--show-text reveals the text only when asked', async () => {
      const p = writeTmp('s.csv', csv(['code,description', '00001,VISIBLE TEXT']));
      const r = await runCli(['--file', p, '--set', 'CPT', '--show-text']);
      assert.ok(r.out.includes('VISIBLE TEXT'));
    });

    it('--apply imports, and requires --source', async () => {
      const p = writeTmp('a.csv', csv(['code,description', '00001,a', '00002,b']));
      const noSource = await runCli(['--file', p, '--set', 'CPT', '--apply']);
      assert.equal(noSource.code, 1);
      assert.match(noSource.err, /--source/);
      const ok = await runCli(['--file', p, '--set', 'CPT', '--source', 'Test 2027', '--apply']);
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.out, /DONE\. Import #1/);
      assert.equal(await count('active'), 2);
    });

    it('a file with bad rows is refused on --apply unless --skip-invalid', async () => {
      const p = writeTmp('b.csv', csv(['code,description', '00001,a', 'BADXX,b']));
      const refused = await runCli(['--file', p, '--set', 'CPT', '--source', 's', '--apply']);
      assert.equal(refused.code, 1);
      assert.equal(await count('active'), 0);
      const ok = await runCli(['--file', p, '--set', 'CPT', '--source', 's', '--apply', '--skip-invalid']);
      assert.equal(ok.code, 0);
      assert.equal(await count('active'), 1);
    });

    it('a missing file or bad option gives a friendly message, not a crash', async () => {
      const missing = await runCli(['--file', '/nope/missing.csv', '--set', 'CPT']);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /Could not open the file/);
      const bad = await runCli(['--file', 'x', '--set', 'CPT', '--bogus']);
      assert.equal(bad.code, 1);
      assert.match(bad.err, /--help/);
    });

    it('a blocked replace explains itself and changes nothing', async () => {
      const big = ['code,description']; for (let i = 1; i <= 20; i++) big.push(String(i).padStart(5, '0') + ',x');
      await runCli(['--file', writeTmp('big.csv', csv(big)), '--set', 'CPT', '--source', 's', '--apply']);
      const r = await runCli(['--file', writeTmp('small.csv', csv(['code,description', '00001,x'])), '--set', 'CPT', '--source', 's', '--apply']);
      assert.equal(r.code, 1);
      assert.match(r.err, /STOPPED/);
      assert.equal(await count('active'), 20);
    });
  });
});
