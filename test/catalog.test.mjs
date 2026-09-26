/**
 * The rule catalog, pinned from three directions.
 *
 * Severity decides pass or fail, so it gets more than one guard: the exact
 * table is asserted literally here, the documented catalog is asserted against
 * it in both directions, and an unknown rule throws rather than defaulting.
 * Flipping one entry fails this file twice.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULE_IDS, RULE_SEVERITY, SEVERITIES, byCodeUnit, severityOf } from '../src/rules.mjs'
import { DEFAULT_LIMITS, HEURISTIC_NOTE, TOOL_ID } from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (...parts) => readFile(join(ROOT, ...parts), 'utf8')

/** Rows of the catalog table in the rules document: rule id to severity. */
async function documentedSeverities() {
  const text = await read('docs', 'meta-snippet-rules.md')
  const rows = new Map()
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/.exec(line)
    if (match !== null) rows.set(match[1], match[2])
  }
  return rows
}

test('the severity table is exactly this, and changing one entry fails here', () => {
  assert.deepEqual(RULE_SEVERITY, {
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
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.equal(RULE_IDS.length, 25)
  assert.deepEqual([...RULE_IDS], [...RULE_IDS].sort(byCodeUnit))
})

test('every rule in the code is documented, with the same severity', async () => {
  const documented = await documentedSeverities()

  for (const ruleId of RULE_IDS) {
    assert.ok(documented.has(ruleId), `docs/meta-snippet-rules.md has no row for "${ruleId}"`)
    assert.equal(documented.get(ruleId), RULE_SEVERITY[ruleId], `severity disagrees for "${ruleId}"`)
  }
})

test('every rule in the document exists in the code', async () => {
  const documented = await documentedSeverities()

  assert.equal(documented.size, RULE_IDS.length)
  for (const ruleId of documented.keys()) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `docs document "${ruleId}", which the code does not define`)
  }
})

test('an unknown rule id throws instead of taking a default severity', () => {
  assert.throws(() => severityOf('title-too-lng'), /Unknown ruleId "title-too-lng"/)
  assert.throws(() => severityOf('toString'), /Unknown ruleId "toString"/)
})

test('every severity used is one of the three the contract defines', () => {
  for (const ruleId of RULE_IDS) {
    assert.ok(SEVERITIES.includes(RULE_SEVERITY[ruleId]), ruleId)
  }
})

test('every documented limit exists in the code with the documented default', async () => {
  const text = await read('docs', 'meta-snippet-rules.md')
  const rows = new Map()
  for (const line of text.split('\n')) {
    const match = /^\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*([0-9]+)\s*\|/.exec(line)
    if (match !== null) rows.set(match[1], { flag: match[2], value: Number(match[3]) })
  }

  assert.deepEqual([...rows.keys()].sort(byCodeUnit), Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))
  for (const [name, row] of rows) {
    assert.equal(row.value, DEFAULT_LIMITS[name], `documented default for ${name}`)
  }

  const help = await read('bin', 'meta-snippet-linter.mjs')
  for (const row of rows.values()) {
    assert.ok(help.includes(row.flag), `the CLI never mentions ${row.flag}`)
  }
})

test('the package manifest matches the tool it ships', async () => {
  const manifest = JSON.parse(await read('package.json'))

  assert.equal(manifest.name, TOOL_ID)
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.bin[TOOL_ID], `./bin/${TOOL_ID}.mjs`)
  assert.equal(manifest.author, 'Edilec Private Limited')
  // Zero runtime and zero development dependencies: Node built-ins only.
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
})

test('the README and the docs carry the same honesty the report does', async () => {
  const readme = await read('README.md')
  const rules = await read('docs', 'meta-snippet-rules.md')

  assert.match(readme, /not search-engine guarantees/)
  assert.match(readme, /## Limits and non-goals/)
  assert.match(readme, /cannot/i)
  // Whitespace-normalised so a line wrap in the document cannot hide the claim.
  assert.match(rules.replace(/\s+/g, ' '), /no search engine publishes a character limit/)
  assert.match(HEURISTIC_NOTE, /no engine publishes a character limit/)
})

test('the changelog records that nothing has been published', async () => {
  const changelog = await read('CHANGELOG.md')

  assert.ok(changelog.trimEnd().endsWith('No release has been published.'))
})

test('no source file reaches for locale collation or a clock', async () => {
  const sources = [
    'src/index.mjs',
    'src/count.mjs',
    'src/html.mjs',
    'src/rules.mjs',
    'bin/meta-snippet-linter.mjs',
  ]

  for (const file of sources) {
    const text = await read(file)
    // Calls, not mentions: the comments in these files explain why each of
    // these is avoided, and saying so must stay allowed.
    assert.doesNotMatch(text, /\.localeCompare\(/, file)
    // Collation has more than one spelling. This is a cheap second net; the
    // ordering that actually matters is pinned behaviourally in
    // test/ordering.test.mjs, on inputs where the two orders disagree.
    assert.doesNotMatch(text, /Intl\.Collator/, file)
    assert.doesNotMatch(text, /Date\.now\(|new Date\(/, file)
    assert.doesNotMatch(text, /Math\.random\(/, file)
    assert.doesNotMatch(text, /readdir\(|[^a-zA-Z.]fetch\(/, file)
  }
})
