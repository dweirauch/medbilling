// What a valid billing code looks like. Shared by the importer and the lookup.
//   CPT:            5 digits (99213), or Category II/III forms ending in F, T or U (0042T).
//   HCPCS Level II: one letter A-V followed by 4 digits (J2405).
const CPT_RE = /^\d{4}[0-9FTU]$/;
const HCPCS_RE = /^[A-V]\d{4}$/;

/** Returns 'CPT', 'HCPCS', or null if the text isn't shaped like either. */
function classifyCode(code) {
  if (typeof code !== 'string') return null;
  if (CPT_RE.test(code)) return 'CPT';
  if (HCPCS_RE.test(code)) return 'HCPCS';
  return null;
}

module.exports = { CPT_RE, HCPCS_RE, classifyCode };
