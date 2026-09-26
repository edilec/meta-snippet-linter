/**
 * Ordering, pinned behaviourally rather than by reading the source.
 *
 * "Order by UTF-16 code unit, never by locale" is a determinism guarantee: the
 * same inputs must serialize to the same bytes on any machine, and locale
 * collation depends on the ICU data compiled into the running Node build. The
 * grep in `test/catalog.test.mjs` catches a literal `localeCompare`, but a
 * comparator is easy to replace with something the grep never sees -- an
 * `Intl.Collator`, a case-folding comparison, a hand-rolled tie-break -- and
 * the committed fixtures were all-lowercase ASCII, where collation and
 * code-unit order agree.
 *
 * So this file uses inputs where the two orders genuinely disagree: uppercase
 * `B` (0x42) sorts before lowercase `a` (0x61) by code unit, and after it under
 * every CLDR collation. Two runs in one process cannot show this -- they share
 * one ICU build -- so it is asserted against the order itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { byCodeUnit } from '../src/rules.mjs'
import { lintMetaSnippets } from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)

/** Words chosen so that code-unit order and collation order disagree. */
const WORDS = ['banana', 'Apple', 'apricot', 'Banana']

test('the comparator is code-unit order, and a collator would give a different answer', () => {
  assert.deepEqual([...WORDS].sort(byCodeUnit), ['Apple', 'Banana', 'apricot', 'banana'])
  assert.ok(byCodeUnit('Banana', 'apricot') < 0, 'B is 0x42 and a is 0x61')
  assert.ok(byCodeUnit('apricot', 'Banana') > 0)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.ok(byCodeUnit('Z', 'a') < 0)
  assert.ok(byCodeUnit('a', String.fromCodePoint(0xe9)) < 0, 'a precedes the precomposed e-acute')

  // Non-vacuity: collation really does disagree on this input, so the order
  // above cannot be satisfied by a comparator that consults a locale.
  const collated = [...WORDS].sort(new Intl.Collator('en', { sensitivity: 'variant' }).compare)
  assert.notDeepEqual(collated, [...WORDS].sort(byCodeUnit))
})

test('the ordering fixture declares its pages in an order that is neither sorted nor collated', async () => {
  const config = JSON.parse(await readFile(fixture('ordering', 'meta.config.json'), 'utf8'))
  const declared = config.pages.map((page) => page.file)

  assert.deepEqual(declared, ['build/Apple.html', 'build/apricot.html', 'build/Banana.html'])
  assert.notDeepEqual(declared, [...declared].sort(byCodeUnit))
})

test('findings are ordered by file in code-unit order, not in declaration or collation order', async () => {
  const report = await lintMetaSnippets({ config: fixture('ordering', 'meta.config.json') })

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['build/Apple.html', 'build/Banana.html', 'build/apricot.html'],
  )
})

test('a duplicate message lists the other pages by code unit, not in declaration order', async () => {
  const report = await lintMetaSnippets({ config: fixture('ordering', 'meta.config.json') })
  const first = report.findings.find((finding) => finding.location.file === 'build/Apple.html')

  assert.equal(first.ruleId, 'title-duplicate')
  // Declaration order would say "/apricot, /Banana", and so would a collator.
  assert.match(first.message, /in locale "en": \/Banana, \/apricot\.$/)
})
