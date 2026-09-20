// Deterministic finish checks evaluated against observed page state in code.
// A model never decides these; they are the independent "done" for a stepwise
// goal. Grammar: repeat flags AND together.
//   url=SUBSTR            location.href contains SUBSTR
//   url_absent=SUBSTR     location.href does not contain SUBSTR
//   title=SUBSTR          document title contains SUBSTR (case-insensitive)
//   text=SUBSTR           visible page text contains SUBSTR (case-insensitive)
//   text_absent=SUBSTR    visible page text does not contain SUBSTR
//   text_count=N:SUBSTR   visible text contains exactly N occurrences of SUBSTR
//                         (N+: at least N, N-M: between)
//   heading=SUBSTR        a visible heading contains SUBSTR (case-insensitive)
//   component=SUBSTR      an observed component label contains SUBSTR
//   value=REF:SUBSTR      observed control REF's current value contains SUBSTR

export class DoneWhenError extends Error {
  constructor(code) { super(code); this.name = 'DoneWhenError'; this.code = code; }
}
const requireValue = (ok, code) => { if (!ok) throw new DoneWhenError(code); };
const clean = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\x00-\x1f]/.test(value);
const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function parseDoneWhen(clauses) {
  requireValue(Array.isArray(clauses) && clauses.length >= 1 && clauses.length <= 12, 'invalid_done_when');
  return clauses.map(raw => {
    requireValue(clean(raw, 320), 'invalid_done_when_clause');
    const count = raw.match(/^text_count=(\d+)(\+|-\d+)?:(.+)$/s);
    if (count) {
      const min = Number(count[1]);
      // "N" exact, "N+" at least N, "N-M" between N and M inclusive.
      const upper = count[2] === '+' ? Infinity : count[2] ? Math.abs(Number(count[2])) : min;
      requireValue(Number.isSafeInteger(min) && min >= 0 && min <= 999 && upper >= min && clean(count[3], 240), 'invalid_done_when_clause');
      return { kind: 'text_count', min, max: upper, text: norm(count[3]) };
    }
    const match = raw.match(/^([a-z_]+)=(.+)$/s);
    requireValue(match && clean(match[2], 240), 'invalid_done_when_clause');
    const [, kind, value] = match;
    if (kind === 'value') {
      const pair = value.match(/^([A-Za-z0-9_-]{1,40}):(.*)$/s);
      requireValue(pair && clean(pair[2], 240), 'invalid_done_when_clause');
      return { kind, ref: pair[1], text: norm(pair[2]) };
    }
    requireValue(['url', 'url_absent', 'title', 'text', 'text_absent', 'heading', 'component'].includes(kind), 'invalid_done_when_kind');
    return { kind, text: kind === 'url' || kind === 'url_absent' ? value : norm(value) };
  });
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) { count++; at += needle.length; }
  return count;
}

/** Evaluate compiled checks against a snapshot data object. Every check must
 * pass (AND). Returns {passed, results:[{clause, passed}]} for evidence. */
export function checkDoneWhen(compiled, data, clauses) {
  const text = norm(data?.text);
  const results = compiled.map((check, i) => {
    let passed = false;
    switch (check.kind) {
      case 'url': passed = String(data?.url || '').includes(check.text); break;
      case 'url_absent': passed = !String(data?.url || '').includes(check.text); break;
      case 'title': passed = norm(data?.title).includes(check.text); break;
      case 'text': passed = text.includes(check.text); break;
      case 'text_absent': passed = !text.includes(check.text); break;
      case 'text_count': { const n = occurrences(text, check.text); passed = n >= check.min && n <= check.max; break; }
      case 'heading': passed = (data?.headings || []).some(h => norm(h).includes(check.text)); break;
      case 'component': passed = (data?.controls || []).some(c => c.component && norm(c.component.label).includes(check.text)); break;
      case 'value': passed = (data?.controls || []).some(c =>
        (c.ref === check.ref || norm(c.what).includes(norm(check.ref)) || norm(c.name) === norm(check.ref))
        && norm(c.value).includes(check.text)); break;
    }
    return { clause: clauses[i], passed };
  });
  return { passed: results.every(r => r.passed), results };
}
