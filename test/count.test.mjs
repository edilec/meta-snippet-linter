import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COUNT_UNITS,
  collapseWhitespace,
  countUnits,
  decodeEntities,
  hasUndecodedEntity,
  normalizeSnippet,
} from '../src/count.mjs'

// Characters are built from code points rather than pasted, so this file has
// no invisible content and the expected numbers can be read off the source.
const WARNING_SIGN = String.fromCodePoint(0x26a0)
const VARIATION_SELECTOR = String.fromCodePoint(0xfe0f)
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d)
const WOMAN = String.fromCodePoint(0x1f469)
const GIRL = String.fromCodePoint(0x1f467)
const COMBINING_ACUTE = String.fromCodePoint(0x0301)
const PRECOMPOSED_E_ACUTE = String.fromCodePoint(0x00e9)
const MATH_X = String.fromCodePoint(0x1d54f)
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0)

test('an emoji with a variation selector counts one grapheme, two code points, two code units', () => {
  const text = WARNING_SIGN + VARIATION_SELECTOR
  assert.equal(countUnits(text, 'graphemes'), 1)
  assert.equal(countUnits(text, 'codePoints'), 2)
  assert.equal(countUnits(text, 'utf16CodeUnits'), 2)
})

test('a zero-width-joiner sequence counts one grapheme, five code points, eight code units', () => {
  const family = WOMAN + ZERO_WIDTH_JOINER + WOMAN + ZERO_WIDTH_JOINER + GIRL
  assert.equal(countUnits(family, 'graphemes'), 1)
  assert.equal(countUnits(family, 'codePoints'), 5)
  assert.equal(countUnits(family, 'utf16CodeUnits'), 8)
})

test('a combining accent counts one grapheme but two code points before normalisation', () => {
  const decomposed = `e${COMBINING_ACUTE}`
  assert.equal(countUnits(decomposed, 'graphemes'), 1)
  assert.equal(countUnits(decomposed, 'codePoints'), 2)
  assert.equal(countUnits(decomposed, 'utf16CodeUnits'), 2)
})

test('normalisation makes the two spellings of one accented letter count identically', () => {
  const decomposed = normalizeSnippet(`Caf${'e' + COMBINING_ACUTE}`, { maxLength: 64 })
  const precomposed = normalizeSnippet(`Caf${PRECOMPOSED_E_ACUTE}`, { maxLength: 64 })

  assert.equal(decomposed.text, precomposed.text)
  assert.equal(decomposed.changedByNormalization, true)
  assert.equal(precomposed.changedByNormalization, false)
  for (const unit of COUNT_UNITS) {
    assert.equal(countUnits(decomposed.text, unit), countUnits(precomposed.text, unit), unit)
  }
  assert.deepEqual(
    COUNT_UNITS.map((unit) => countUnits(decomposed.text, unit)),
    [4, 4, 4],
  )
})

test('an astral character is one grapheme, one code point and two code units', () => {
  assert.deepEqual(
    COUNT_UNITS.map((unit) => countUnits(MATH_X, unit)),
    [1, 1, 2],
  )
})

test('countUnits refuses a unit it does not implement', () => {
  assert.throws(() => countUnits('x', 'bytes'), /Unknown counting unit "bytes"/)
})

test('whitespace collapses the way a browser lays a title out, and a no-break space survives', () => {
  assert.equal(collapseWhitespace('  Edilec\n\t  Meta   Linter  '), 'Edilec Meta Linter')
  assert.equal(
    collapseWhitespace(`Edilec${NO_BREAK_SPACE}Linter`),
    `Edilec${NO_BREAK_SPACE}Linter`,
  )
  assert.equal(countUnits(`Edilec${NO_BREAK_SPACE}Linter`, 'graphemes'), 13)
})

test('the documented entity table and numeric references decode; anything else is left alone', () => {
  assert.equal(decodeEntities('Cost &lt; &amp; &gt; &quot;x&quot;'), 'Cost < & > "x"')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeEntities('Pricing &mdash; Edilec'), `Pricing ${String.fromCodePoint(0x2014)} Edilec`)
  assert.equal(decodeEntities('&frac12; of it'), '&frac12; of it')
  assert.equal(hasUndecodedEntity(decodeEntities('&frac12; of it')), true)
  assert.equal(hasUndecodedEntity(decodeEntities('Cost &lt; 5')), false)
})

test('a numeric reference for a surrogate or a control character is left as written', () => {
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;')
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;')
  assert.equal(decodeEntities('&#7;'), '&#7;')
})

test('a snippet past the bound is reported truncated and never split through a surrogate pair', () => {
  const snippet = normalizeSnippet(`abc${MATH_X}def`, { maxLength: 4 })
  assert.equal(snippet.truncated, true)
  assert.equal(snippet.sourceLength, 8)
  // The bound falls inside the surrogate pair, so the pair is dropped whole.
  assert.equal(snippet.text, 'abc')
  assert.equal(countUnits(snippet.text, 'codePoints'), 3)
})

test('a snippet inside the bound is not reported truncated', () => {
  const snippet = normalizeSnippet('abcdef', { maxLength: 6 })
  assert.equal(snippet.truncated, false)
  assert.equal(snippet.text, 'abcdef')
})

test('normalizeSnippet refuses a bound that is not a positive integer', () => {
  assert.throws(() => normalizeSnippet('x', { maxLength: 0 }), /maxLength must be a positive integer/)
})
