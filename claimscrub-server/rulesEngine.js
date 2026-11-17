// ---------------------------------------------------------------------------
// ClaimScrub rules engine — SERVER-SIDE COPY.
//
// This must stay in sync with the reference data and logic in the client
// tool (claimscrub-tool.html). It's duplicated here deliberately: the whole
// point of running this on the server is that the paywall decision (was a
// red flag found?) can't be spoofed by a user editing client-side JS.
//
// The code list below is only a small BUILT-IN SAMPLE. The real lists are loaded
// into the database with the importer (scripts/import-codes.js) and looked up
// through referenceStore.js. This sample is the fallback until that happens.
// ---------------------------------------------------------------------------

const DEMO_CPT_REF = {
  "99202":"Office/outpatient visit, new patient, straightforward",
  "99203":"Office/outpatient visit, new patient, low complexity",
  "99204":"Office/outpatient visit, new patient, moderate complexity",
  "99205":"Office/outpatient visit, new patient, high complexity",
  "99211":"Office/outpatient visit, established patient, minimal",
  "99212":"Office/outpatient visit, established patient, straightforward",
  "99213":"Office/outpatient visit, established patient, low complexity",
  "99214":"Office/outpatient visit, established patient, moderate complexity",
  "99215":"Office/outpatient visit, established patient, high complexity",
  "99281":"Emergency department visit, level 1 (minor)",
  "99282":"Emergency department visit, level 2 (low-to-moderate)",
  "99283":"Emergency department visit, level 3 (moderate)",
  "99284":"Emergency department visit, level 4 (moderate-to-high severity)",
  "99285":"Emergency department visit, level 5 (high severity)",
  "99221":"Initial hospital care, low complexity",
  "99222":"Initial hospital care, moderate complexity",
  "99223":"Initial hospital care, high complexity",
  "99231":"Subsequent hospital care, low complexity",
  "99232":"Subsequent hospital care, moderate complexity",
  "99233":"Subsequent hospital care, high complexity",
  "99238":"Hospital discharge management, 30 min or less",
  "99239":"Hospital discharge management, more than 30 min",
  "80053":"Comprehensive metabolic panel",
  "80048":"Basic metabolic panel",
  "80061":"Lipid panel",
  "85025":"Complete blood count (CBC) with differential",
  "85027":"Complete blood count (CBC), automated",
  "81001":"Urinalysis, automated, with microscopy",
  "81003":"Urinalysis, automated, without microscopy",
  "81025":"Urine pregnancy test, visual color comparison",
  "82803":"Blood gases, arterial",
  "82947":"Glucose, blood test",
  "83036":"Hemoglobin A1c",
  "84443":"Thyroid stimulating hormone (TSH)",
  "36415":"Collection of venous blood by venipuncture",
  "87070":"Bacterial culture, general",
  "87804":"Rapid influenza assay",
  "87880":"Rapid strep test",
  "36591":"Collection of blood from an implanted venous access device",
  "70450":"CT scan of head/brain, without contrast",
  "70460":"CT scan of head/brain, with contrast",
  "71045":"Chest X-ray, 1 view",
  "71046":"Chest X-ray, 2 views",
  "72100":"X-ray of lower spine, 2-3 views",
  "73030":"X-ray of shoulder, complete",
  "73721":"MRI, lower extremity joint",
  "74176":"CT scan of abdomen and pelvis, without contrast",
  "76700":"Abdominal ultrasound, complete",
  "76705":"Abdominal ultrasound, limited",
  "93000":"Electrocardiogram, complete",
  "93005":"Electrocardiogram, tracing only",
  "96360":"IV infusion, hydration, initial 31-60 min",
  "96361":"IV infusion, hydration, each additional hour",
  "96365":"IV infusion, therapeutic, initial",
  "96366":"IV infusion, therapeutic, each additional hour",
  "96372":"Therapeutic injection, subcutaneous or intramuscular",
  "96374":"Therapeutic IV push, initial substance/drug",
  "96375":"Therapeutic IV push, each additional sequential substance/drug",
  "12001":"Simple repair of superficial wound, 2.5cm or less",
  "12002":"Simple repair of superficial wound, 2.6-7.5cm",
  "29125":"Application of short arm splint",
  "29426":"Application of below-knee splint",
  "29826":"Arthroscopic shoulder decompression",
  "29827":"Arthroscopic rotator cuff repair",
  "90471":"Immunization administration, one vaccine",
  "90472":"Immunization administration, each additional vaccine",
  "J2405":"Ondansetron HCl injection, per 1mg",
  "J2550":"Promethazine HCl injection, up to 50mg",
  "J1200":"Diphenhydramine HCl injection, up to 50mg",
  "J0696":"Ceftriaxone sodium injection, per 250mg",
  "J1885":"Ketorolac tromethamine injection, per 15mg",
  "S0028":"Famotidine injection",
  "J3490":"Unclassified drug",
  "A0429":"Ambulance service, basic life support, emergency"
};

const UNBUNDLE_PAIRS = [
  ["29826","29827"],
  ["36415","80053"],
  ["36415","85025"],
  ["36415","80048"],
  ["12001","99213"],
  ["12001","99214"],
  ["96372","99213"],
  ["96372","99214"],
  ["96374","96372"],
  ["71045","71046"],
  ["80048","80053"],
  ["81001","81003"],
  ["93000","93005"],
  ["76700","76705"],
  ["29125","99283"],
  ["29125","99284"]
];

const VALID_MODIFIERS = {
  "25":"Significant, separately identifiable E/M service",
  "59":"Distinct procedural service",
  "76":"Repeat procedure, same physician",
  "91":"Repeat clinical diagnostic lab test",
  "LT":"Left side",
  "RT":"Right side",
  "50":"Bilateral procedure"
};

const HIGH_COMPLEXITY_EM = new Set(["99215","99205","99223","99284","99285","99233"]);

// A code list passed to auditItems(). get(code) -> { description, status } or undefined.
function makeReference(codeToDescription) {
  const map = new Map(Object.entries(codeToDescription).map(([code, description]) => [code, { description, status: 'active' }]));
  return { source: 'demo', get: (code) => map.get(code) };
}
const demoReference = makeReference(DEMO_CPT_REF);

// "Usually billed once per visit" vs "repeatable but capped" is a judgment about
// each code, kept here so it does NOT depend on the wording of imported official
// descriptions (e.g. the official chest X-ray wording doesn't contain "x-ray").
const ONCE_PER_ENCOUNTER = new Set(Object.keys(DEMO_CPT_REF).filter(c =>
  /visit|panel|x-ray|ultrasound|electrocardiogram|urinalysis|pregnancy test/i.test(DEMO_CPT_REF[c])));
const REPEATABLE_BUT_CAPPED = new Set(Object.keys(DEMO_CPT_REF).filter(c =>
  /injection|infusion|iv push/i.test(DEMO_CPT_REF[c])));

/**
 * Expects an array of line items already parsed on the client:
 * { code, modifier (nullable), desc, qty, charge }
 * Returns the same array with a `flags` array attached to each item,
 * exactly matching the client-side logic in claimscrub-tool.html.
 */
function auditItems(items, reference = demoReference) {
  const results = items.map(it => {
    const known = reference.get(it.code);
    return { ...it, description: known ? known.description : null, flags: [] };
  });

  // 1. Duplicate detection
  const seen = {};
  results.forEach(it => {
    const key = it.code + '|' + it.charge;
    seen[key] = (seen[key] || 0) + 1;
  });
  results.forEach(it => {
    const key = it.code + '|' + it.charge;
    if (seen[key] > 1) {
      it.flags.push({ level: 'red', reason: 'This exact code and charge appears ' + seen[key] + ' times. Likely a duplicate billing.' });
    }
  });

  // 2. Unbundling
  const codesPresent = new Set(results.map(r => r.code));
  UNBUNDLE_PAIRS.forEach(([a, b]) => {
    if (codesPresent.has(a) && codesPresent.has(b)) {
      results.forEach(it => {
        if (it.code === a || it.code === b) {
          it.flags.push({ level: 'red', reason: 'Billed alongside ' + (it.code === a ? b : a) + ', a pairing that is typically bundled into one comprehensive code.' });
        }
      });
    }
  });

  // 3. Unknown or retired code
  results.forEach(it => {
    const known = reference.get(it.code);
    if (!known) {
      it.flags.push({ level: 'yellow', reason: 'Code not found in the standard reference set — could be valid but uncommon, or mistyped/invalid. Worth confirming.' });
    } else if (known.status === 'retired') {
      it.flags.push({ level: 'yellow', reason: 'This code is no longer in the current code set (it was retired in a recent update). It may be valid only for older dates of service, so it is worth confirming the date of service on the bill.' });
    }
  });

  // 4. Modifier check
  results.forEach(it => {
    if (it.modifier && !VALID_MODIFIERS[it.modifier]) {
      it.flags.push({ level: 'yellow', reason: 'Modifier "' + it.modifier + '" is not a recognized standard modifier for this context.' });
    }
  });

  // 5. Quantity check
  results.forEach(it => {
    if (it.charge != null && it.qty > 1) {
      const onceTypical = ONCE_PER_ENCOUNTER.has(it.code);
      const repeatableButCapped = REPEATABLE_BUT_CAPPED.has(it.code);
      if (onceTypical && it.qty >= 2) {
        it.flags.push({ level: 'yellow', reason: 'Quantity of ' + it.qty + ' is unusual for a service typically billed once per encounter.' });
      } else if (repeatableButCapped && it.qty >= 8) {
        it.flags.push({ level: 'yellow', reason: 'Quantity of ' + it.qty + ' is unusually high for this type of injection/infusion in a single visit — worth confirming against the medical record.' });
      }
    }
  });

  // 6. Upcoding heuristic (weak signal, always yellow)
  const hasSupportingCodes = results.some(r => {
    const known = reference.get(r.code);
    return !HIGH_COMPLEXITY_EM.has(r.code) && known && known.status === 'active';
  });
  results.forEach(it => {
    if (HIGH_COMPLEXITY_EM.has(it.code) && !hasSupportingCodes) {
      it.flags.push({ level: 'yellow', reason: 'This is a high-complexity visit code billed with no other procedure, lab, or imaging codes on the bill to support that level of complexity. This is a weak signal, not a confirmed error.' });
    }
  });

  return results;
}

function summarize(results) {
  const redCount = results.filter(it => it.flags.some(f => f.level === 'red')).length;
  const yellowCount = results.filter(it => !it.flags.some(f => f.level === 'red') && it.flags.length).length;
  const clearCount = results.length - redCount - yellowCount;
  const redCharges = results
    .filter(it => it.flags.some(f => f.level === 'red'))
    .reduce((sum, it) => sum + (it.charge || 0), 0);
  return { redCount, yellowCount, clearCount, redCharges };
}

module.exports = { CPT_REF: DEMO_CPT_REF, DEMO_CPT_REF, makeReference, UNBUNDLE_PAIRS, VALID_MODIFIERS, auditItems, summarize };
