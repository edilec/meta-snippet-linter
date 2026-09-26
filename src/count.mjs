/**
 * How a snippet becomes a number.
 *
 * Counting is the subtle part of this tool, so the whole pipeline lives in one
 * file and is applied identically to every title and every description:
 *
 *   1. decode character references (a bounded named table plus numeric ones),
 *   2. collapse ASCII whitespace runs to one space and trim,
 *   3. normalise to NFC,
 *   4. bound the length,
 *   5. count in the configured unit.
 *
 * Step 3 is a decision worth stating. Two titles that look identical can be
 * encoded differently: "e" followed by U+0301 and the precomposed U+00E9 paint
 * the same glyph but differ in code points and in bytes. Counting the source
 * form would give the same visible title two different lengths depending on
 * which build step emitted it, and would let two identical-looking titles
 * escape duplicate grouping. So the NFC form is what gets counted and what gets
 * grouped, and a page whose source was not already NFC is told so.
 */

/**
 * The named character references this tool decodes.
 *
 * The full HTML named reference set is over two thousand entries; carrying it
 * would be carrying a copy of someone else's table. This is the set that
 * actually appears in hand-written titles and descriptions. Anything outside it
 * is left exactly as written and reported with `entity-not-decoded`, so an
 * inaccurate count is visible rather than silent.
 *
 * Values are built from code points rather than written literally so that this
 * source file contains no invisible characters.
 */
export const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  bull: String.fromCodePoint(0x2022),
  copy: String.fromCodePoint(0x00a9),
  deg: String.fromCodePoint(0x00b0),
  gt: '>',
  hellip: String.fromCodePoint(0x2026),
  laquo: String.fromCodePoint(0x00ab),
  ldquo: String.fromCodePoint(0x201c),
  lsquo: String.fromCodePoint(0x2018),
  lt: '<',
  mdash: String.fromCodePoint(0x2014),
  middot: String.fromCodePoint(0x00b7),
  nbsp: String.fromCodePoint(0x00a0),
  ndash: String.fromCodePoint(0x2013),
  quot: '"',
  raquo: String.fromCodePoint(0x00bb),
  rdquo: String.fromCodePoint(0x201d),
  reg: String.fromCodePoint(0x00ae),
  rsquo: String.fromCodePoint(0x2019),
  times: String.fromCodePoint(0x00d7),
  trade: String.fromCodePoint(0x2122),
})

export const COUNT_UNITS = Object.freeze(['graphemes', 'codePoints', 'utf16CodeUnits'])

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g
const LEFTOVER_ENTITY = /&[a-zA-Z][a-zA-Z0-9]{1,31};/

const TAB = 0x09
const LINE_FEED = 0x0a
const FORM_FEED = 0x0c
const CARRIAGE_RETURN = 0x0d
const SPACE = 0x20
const MAX_CODE_POINT = 0x10ffff
const SURROGATE_FIRST = 0xd800
const SURROGATE_LAST = 0xdfff
const HIGH_SURROGATE_LAST = 0xdbff

/**
 * True when the running Node build can segment grapheme clusters.
 *
 * A build compiled with small-icu has no `Intl.Segmenter`. Falling back to code
 * points there would mean the same configuration silently counts differently on
 * two machines, so the caller refuses the configuration instead.
 */
export function graphemeSupport() {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
}

let cachedSegmenter = null

function segmenter() {
  if (cachedSegmenter === null) {
    if (!graphemeSupport()) {
      throw new RangeError('Grapheme counting requires Intl.Segmenter, which this Node build does not provide')
    }
    // A fixed locale, never the host default: segmentation must not depend on
    // the environment the tool happens to run in.
    cachedSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  }
  return cachedSegmenter
}

export function isAsciiWhitespace(code) {
  return code === TAB || code === LINE_FEED || code === FORM_FEED || code === CARRIAGE_RETURN || code === SPACE
}

/**
 * Collapse runs of ASCII whitespace to a single space and trim, the way a
 * browser lays out a title.
 *
 * Only the five ASCII space characters are collapsed. A no-break space is a
 * character the author chose and it is counted as one.
 */
export function collapseWhitespace(text) {
  let out = ''
  let pending = false
  for (let index = 0; index < text.length; index += 1) {
    if (isAsciiWhitespace(text.charCodeAt(index))) {
      pending = out.length > 0
      continue
    }
    if (pending) {
      out += ' '
      pending = false
    }
    out += text[index]
  }
  return out
}

export function decodeEntities(text) {
  return String(text).replace(ENTITY, (match, body) => {
    if (body[0] !== '#') {
      return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match
    }
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
    if (!Number.isInteger(code) || code > MAX_CODE_POINT) return match
    if (code >= SURROGATE_FIRST && code <= SURROGATE_LAST) return match
    if (code < SPACE && !isAsciiWhitespace(code)) return match
    return String.fromCodePoint(code)
  })
}

export function hasUndecodedEntity(text) {
  return LEFTOVER_ENTITY.test(text)
}

/** Slice without splitting a surrogate pair down the middle. */
function boundedSlice(text, maxLength) {
  let end = maxLength
  const code = text.charCodeAt(end - 1)
  if (code >= SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST) end -= 1
  return text.slice(0, end)
}

/**
 * Run the whole pipeline over one raw snippet.
 *
 * `truncated` is not a formatting detail: a snippet longer than the bound was
 * not fully seen, so the caller must refuse to assess its length and must
 * refuse to group it with anything.
 */
export function normalizeSnippet(raw, options = {}) {
  const maxLength = options.maxLength ?? Number.MAX_SAFE_INTEGER
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer')
  }
  const collapsed = collapseWhitespace(decodeEntities(raw))
  const normalized = collapsed.normalize('NFC')
  const truncated = normalized.length > maxLength
  const text = truncated ? boundedSlice(normalized, maxLength) : normalized
  return {
    text,
    truncated,
    sourceLength: normalized.length,
    changedByNormalization: normalized !== collapsed,
    undecodedEntity: hasUndecodedEntity(text),
  }
}

/**
 * Count one snippet in one unit.
 *
 * - `utf16CodeUnits` is `String.prototype.length`: what a JavaScript program
 *   sees, and what most byte-oriented pipelines end up measuring.
 * - `codePoints` counts Unicode scalar values: an emoji outside the BMP is one,
 *   a variation selector is a separate one.
 * - `graphemes` counts user-perceived characters via `Intl.Segmenter`: an emoji
 *   with a variation selector is one, and so is a base letter followed by a
 *   combining mark.
 */
export function countUnits(text, unit) {
  if (unit === 'utf16CodeUnits') return text.length
  if (unit === 'codePoints') {
    let total = 0
    for (const character of text) {
      if (character !== undefined) total += 1
    }
    return total
  }
  if (unit === 'graphemes') {
    let total = 0
    for (const segment of segmenter().segment(text)) {
      if (segment !== undefined) total += 1
    }
    return total
  }
  throw new RangeError(`Unknown counting unit "${String(unit)}"`)
}
