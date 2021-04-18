/**
 * The rule catalog, the severity table, and the ordering the report depends on.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Left as a literal at every construction site it drifts silently: one
 * edit flips a refusal into a green build and no test notices. So there is
 * exactly one table, every finding takes its severity from it, an unknown rule
 * throws instead of defaulting, and `docs/meta-snippet-rules.md` is asserted
 * against this table in both directions.
 */

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/**
 * A length bound is an error because the operator declared it.
 *
 * The bound itself is house style and the report says so in as many words: no
 * search engine publishes a character limit. But a linter that only ever warns
 * about the policy it was handed does not enforce that policy at all, and a
 * configured bound that cannot fail a build is a configured bound nobody reads.
 * The honesty belongs in the wording, not in a severity that makes the check
 * inert.
 */
export const RULE_SEVERITY = Object.freeze({
  'charset-not-utf8': 'warning',
  'description-duplicate': 'error',
  'description-empty': 'error',
  'description-missing': 'error',
  'description-repeated-element': 'warning',
  'description-too-long': 'error',
  'description-too-short': 'error',
  'entity-not-decoded': 'info',
  'head-scan-truncated': 'warning',
  'html-lang-mismatch': 'warning',
  'html-lang-missing': 'info',
  'locale-not-declared': 'error',
  'nothing-checked': 'error',
  'page-limit-exceeded': 'error',
  'page-not-utf8': 'error',
  'page-too-large': 'error',
  'page-unreadable': 'error',
  'text-not-nfc': 'info',
  'text-truncated': 'warning',
  'title-duplicate': 'error',
  'title-empty': 'error',
  'title-missing': 'error',
  'title-repeated-element': 'warning',
  'title-too-long': 'error',
  'title-too-short': 'error',
})

/**
 * Order by UTF-16 code unit, never by locale.
 *
 * `localeCompare` depends on the ICU data compiled into the running Node
 * build, so the same inputs can order differently on two machines. Code-unit
 * order is a property of the strings themselves.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export const RULE_IDS = Object.freeze([...Object.keys(RULE_SEVERITY)].sort(byCodeUnit))

export const EVIDENCE_LIMIT = 160

/** How much input an excerpt will ever scan, however long the value is. */
const SCRUB_LIMIT = 8192

/**
 * Characters that would break a line, a terminal or a log reader: the C0 and
 * C1 control ranges plus the two Unicode line separators. Written as code
 * point arithmetic rather than a character class so the source file itself can
 * never contain the control characters it is describing.
 */
function isUnprintable(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

export function severityOf(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) {
    throw new RangeError(`Unknown ruleId "${ruleId}"`)
  }
  return RULE_SEVERITY[ruleId]
}

/**
 * A bounded, single-line excerpt.
 *
 * Page content is data. It is never echoed at length, and never echoed in a
 * shape that could be mistaken for an instruction to whoever reads the report.
 */
export function excerpt(value) {
  // Bounded work as well as bounded output: the caller may hand this an
  // attribute value straight out of a two-megabyte document.
  const source = String(value).slice(0, SCRUB_LIMIT)
  let scrubbed = ''
  for (let index = 0; index < source.length; index += 1) {
    scrubbed += isUnprintable(source.charCodeAt(index)) ? ' ' : source[index]
  }
  const flattened = scrubbed.replace(/\s+/g, ' ').trim()
  if (flattened.length <= EVIDENCE_LIMIT) return flattened
  return `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

/**
 * Build a location. `line` and `column` are 1-based and tool-specific: the
 * report contract defines `file` and `pointer`, and this tool adds the source
 * position of the element a finding is about, because "which tag" is the first
 * thing a reader needs.
 */
export function at(file, pointer, position = null) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  if (position !== null && position !== undefined) {
    location.line = position.line
    location.column = position.column
  }
  return location
}

export function makeFinding(ruleId, message, location, extra = {}) {
  const finding = { ruleId, severity: severityOf(ruleId), message, location }
  if (extra.evidence !== undefined && extra.evidence !== null) finding.evidence = excerpt(extra.evidence)
  if (extra.suggestion !== undefined && extra.suggestion !== null) finding.suggestion = extra.suggestion
  return finding
}

/**
 * The documented sort key: file, pointer, ruleId, line, column, message.
 *
 * A missing file or pointer sorts as the empty string and a missing position
 * sorts as 0, so config-level findings come first and every run over the same
 * inputs serializes to the same bytes.
 */
export function compareFindings(left, right) {
  const keys = [
    byCodeUnit(left.location?.file ?? '', right.location?.file ?? ''),
    byCodeUnit(left.location?.pointer ?? '', right.location?.pointer ?? ''),
    byCodeUnit(left.ruleId, right.ruleId),
    (left.location?.line ?? 0) - (right.location?.line ?? 0),
    (left.location?.column ?? 0) - (right.location?.column ?? 0),
    byCodeUnit(left.message, right.message),
  ]
  for (const key of keys) {
    if (key !== 0) return key
  }
  return 0
}
