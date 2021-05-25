import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COUNT_UNITS,
  ConfigError,
  HEURISTIC_NOTE,
  RULE_SEVERITY,
  auditProject,
  compareFindings,
  countUnits,
  exitCodeFor,
  lintMetaSnippets,
  loadProject,
  serializeReport,
  validateConfig,
} from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)
const example = (...parts) => join(ROOT, 'examples', ...parts)

const shape = (report) =>
  report.findings.map((finding) => [
    finding.location.file ?? null,
    finding.location.pointer ?? null,
    finding.ruleId,
  ])

function baseConfig(overrides = {}) {
  return {
    schemaVersion: '1',
    counting: 'graphemes',
    duplicateScope: 'locale',
    defaults: { title: { min: 1, max: 60 }, description: { min: 1, max: 160 } },
    locales: { en: {} },
    pages: [{ path: '/', file: 'build/index.html', locale: 'en' }],
    ...overrides,
  }
}

test('acceptance: the clean example passes with nothing skipped', async () => {
  const report = await lintMetaSnippets({ config: example('clean', 'meta.config.json') })

  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.deepEqual(report.summary, {
    checked: 3,
    errors: 0,
    warnings: 0,
    info: 0,
    pages: 3,
    skipped: 0,
    duplicateGroups: 0,
  })
  assert.deepEqual(report.findings, [])
})

test('acceptance: the broken example fails with exactly these findings, in this order', async () => {
  const report = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })

  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(shape(report), [
    ['build/about.html', '/head/meta[name=description]', 'description-missing'],
    ['build/about.html', '/head/title', 'title-too-long'],
    ['build/copy.html', '/head/meta[name=description]', 'description-duplicate'],
    ['build/copy.html', '/head/title', 'title-duplicate'],
    ['build/copy.html', '/head/title', 'title-too-short'],
    ['build/fr.html', '/document', 'locale-not-declared'],
    ['build/index.html', '/head/meta[name=description]', 'description-duplicate'],
    ['build/index.html', '/head/title', 'title-duplicate'],
    ['build/index.html', '/head/title', 'title-too-short'],
    ['build/legacy.html', '/head/title', 'title-repeated-element'],
    ['build/legacy.html', '/html[lang]', 'html-lang-mismatch'],
  ])
  assert.deepEqual(report.summary, {
    checked: 4,
    errors: 9,
    warnings: 2,
    info: 0,
    pages: 5,
    skipped: 1,
    duplicateGroups: 2,
  })
})

test('acceptance: two spellings of the same Unicode title count alike and group as duplicates', async () => {
  const project = await loadProject({ config: fixture('unicode', 'meta.config.json') })
  const report = auditProject(project)

  // The duplicate group is the point: the pages differ byte for byte.
  const nfcSource = project.documents.get('build/nfc.html').source
  const nfdSource = project.documents.get('build/nfd.html').source
  assert.notEqual(nfcSource, nfdSource)

  assert.deepEqual(shape(report), [
    ['build/nfc.html', '/head/title', 'title-duplicate'],
    ['build/nfd.html', '/head/title', 'text-not-nfc'],
    ['build/nfd.html', '/head/title', 'title-duplicate'],
  ])
  assert.equal(report.summary.duplicateGroups, 1)

  const evidence = report.findings
    .filter((finding) => finding.ruleId === 'title-duplicate')
    .map((finding) => finding.evidence)
  assert.equal(evidence[0], evidence[1])
  assert.deepEqual(
    COUNT_UNITS.map((unit) => countUnits(evidence[0], unit)),
    [20, 21, 21],
  )
})

test('acceptance: duplicate grouping follows the configured scope, and the scope decides the verdict', async () => {
  const withinLocale = await lintMetaSnippets({ config: fixture('scope', 'meta.config.json') })
  const acrossSite = await lintMetaSnippets({
    config: fixture('scope', 'meta.config.json'),
    duplicateScope: 'site',
  })

  assert.equal(withinLocale.status, 'pass')
  assert.deepEqual(shape(withinLocale), [])
  assert.equal(withinLocale.summary.duplicateGroups, 0)

  assert.equal(acrossSite.status, 'fail')
  assert.deepEqual(shape(acrossSite), [
    ['build/de.html', '/head/title', 'title-duplicate'],
    ['build/en.html', '/head/title', 'title-duplicate'],
  ])
  assert.equal(acrossSite.summary.duplicateGroups, 1)
})

test('acceptance: length rules are stated as heuristics, never as search-engine guarantees', async () => {
  const report = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })
  const lengthFindings = report.findings.filter((finding) => /-too-(short|long)$/.test(finding.ruleId))

  assert.equal(lengthFindings.length, 3)
  for (const finding of lengthFindings) {
    assert.match(finding.message, /house-style heuristic, not a search-engine guarantee/)
  }
  assert.equal(report.notes[0], HEURISTIC_NOTE)
  assert.match(HEURISTIC_NOTE, /not search-engine guarantees/)

  // No finding may promise a ranking outcome of any kind.
  const promises = /\b(will rank|ranks higher|guaranteed|Google requires|SEO score)\b/i
  for (const finding of report.findings) {
    assert.doesNotMatch(finding.message, promises)
    assert.doesNotMatch(finding.suggestion ?? '', promises)
  }
})

test('a duplicate message names the other pages in the group, sorted by code unit', async () => {
  const report = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })
  const finding = report.findings.find(
    (candidate) => candidate.ruleId === 'title-duplicate' && candidate.location.file === 'build/copy.html',
  )

  assert.match(finding.message, /shares its title with 1 other page\(s\) in locale "en": \//)
})

test('the counting unit is wired through and can change the verdict', async () => {
  const asGraphemes = await lintMetaSnippets({ config: fixture('counting', 'meta.config.json') })
  const asCodePoints = await lintMetaSnippets({
    config: fixture('counting', 'meta.config.json'),
    counting: 'codePoints',
  })

  assert.equal(asGraphemes.status, 'pass')
  assert.deepEqual(shape(asGraphemes), [])
  assert.equal(asCodePoints.status, 'fail')
  assert.deepEqual(shape(asCodePoints), [['build/ja.html', '/head/title', 'title-too-long']])
  assert.match(asCodePoints.findings[0].message, /17 codePoints long, above the maximum of 16/)
})

test('every finding takes its severity from the one frozen table', async () => {
  const report = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })

  assert.ok(report.findings.length > 0)
  for (const finding of report.findings) {
    assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId], finding.ruleId)
  }
})

test('the report is byte-identical across runs', async () => {
  const first = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })
  const second = await lintMetaSnippets({ config: example('broken', 'meta.config.json') })

  assert.equal(serializeReport(first), serializeReport(second))
})

test('findings sort by file, then pointer, then rule, then position', () => {
  const unsorted = [
    { ruleId: 'title-too-long', message: 'd', location: { file: 'b.html', pointer: '/head/title', line: 9, column: 1 } },
    { ruleId: 'title-too-long', message: 'c', location: { file: 'a.html', pointer: '/head/title', line: 9, column: 1 } },
    { ruleId: 'title-too-long', message: 'b', location: { file: 'a.html', pointer: '/head/title', line: 2, column: 1 } },
    { ruleId: 'description-missing', message: 'a', location: { file: 'a.html', pointer: '/head/title', line: 9, column: 1 } },
    { ruleId: 'nothing-checked', message: 'z', location: { pointer: '/pages' } },
  ]
  const sorted = [...unsorted].sort(compareFindings).map((finding) => finding.message)

  assert.deepEqual(sorted, ['z', 'a', 'b', 'c', 'd'])
})

test('an unknown config key is refused rather than ignored', () => {
  assert.throws(
    () => validateConfig({ ...baseConfig(), duplcateScope: 'site' }),
    /Unknown config key "duplcateScope"/,
  )
})

test('an unknown limit is refused from the config and from an override', () => {
  assert.throws(() => validateConfig(baseConfig({ limits: { maxPage: 4 } })), /Unknown limit "maxPage"/)
  assert.throws(() => validateConfig(baseConfig(), { limits: { maxPage: 4 } }), /Unknown limit "maxPage"/)
})

test('counting and duplicateScope have no default, because both change the answer', () => {
  const { counting, ...withoutCounting } = baseConfig()
  const { duplicateScope, ...withoutScope } = baseConfig()

  assert.equal(counting, 'graphemes')
  assert.equal(duplicateScope, 'locale')
  assert.throws(() => validateConfig(withoutCounting), /counting must be one of/)
  assert.throws(() => validateConfig(withoutScope), /duplicateScope must be one of/)
})

test('the page list must be non-empty and free of repeated paths', () => {
  assert.throws(() => validateConfig(baseConfig({ pages: [] })), /non-empty pages array/)
  assert.throws(
    () =>
      validateConfig(
        baseConfig({
          pages: [
            { path: '/', file: 'a.html', locale: 'en' },
            { path: '/', file: 'b.html', locale: 'en' },
          ],
        }),
      ),
    /declared more than once/,
  )
})

test('bounds, locale tags and page shapes are validated', () => {
  assert.throws(
    () => validateConfig(baseConfig({ defaults: { title: { min: 9, max: 4 }, description: { min: 1, max: 2 } } })),
    /defaults.title.min must not exceed defaults.title.max/,
  )
  assert.throws(() => validateConfig(baseConfig({ locales: { 'not a tag': {} } })), /is not a usable locale tag/)
  assert.throws(() => validateConfig(baseConfig({ locales: {} })), /at least one locale tag/)
  assert.throws(
    () => validateConfig(baseConfig({ pages: [{ path: 'index.html', file: 'a.html', locale: 'en' }] })),
    /must be a site-relative path/,
  )
  assert.throws(
    () => validateConfig(baseConfig({ pages: [{ path: '/', file: 'a.html', locale: 'en', indexable: true }] })),
    /Unknown key "indexable" in pages\[0\]/,
  )
  assert.throws(
    () => validateConfig(baseConfig({ locales: { en: { titel: { max: 4 } } } })),
    /Unknown key "titel" in locales.en/,
  )
})

test('a locale override merges over the defaults rather than replacing them', () => {
  const config = validateConfig(baseConfig({ locales: { en: {}, ja: { title: { max: 32 } } } }))

  assert.deepEqual(config.locales.get('ja').title, { min: 1, max: 32 })
  assert.deepEqual(config.locales.get('ja').description, { min: 1, max: 160 })
  assert.deepEqual(config.locales.get('en').title, { min: 1, max: 60 })
})

test('a missing or unparseable config is a ConfigError, not a report', async () => {
  await assert.rejects(() => lintMetaSnippets({ config: fixture('invalid', 'not-json.config.json') }), ConfigError)
  await assert.rejects(() => lintMetaSnippets({ config: fixture('invalid', 'absent.config.json') }), /Could not read the config/)
  await assert.rejects(() => lintMetaSnippets({}), /A config file path is required/)
})

test('a run that measured nothing is never a pass', async () => {
  const report = await lintMetaSnippets({ config: fixture('nothing', 'meta.config.json') })

  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.deepEqual(shape(report), [
    [null, '/pages', 'nothing-checked'],
    ['build/one.html', '/document', 'locale-not-declared'],
  ])
  // Both of these are errors, and the summary a consumer reads says so. The
  // exit code alone cannot show it: either rule on its own already fails.
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
})

test('empty, missing and undecodable-entity snippets are each reported once', async () => {
  const report = await lintMetaSnippets({ config: fixture('edge', 'meta.config.json') })

  assert.equal(report.status, 'fail')
  assert.deepEqual(shape(report), [
    ['build/blank.html', '/head/meta[name=description]', 'description-empty'],
    ['build/blank.html', '/head/meta[name=description]', 'description-repeated-element'],
    ['build/blank.html', '/head/title', 'title-empty'],
    ['build/no-title.html', '/head/meta[name=description]', 'entity-not-decoded'],
    ['build/no-title.html', '/head/title', 'title-missing'],
    ['build/no-title.html', '/html[lang]', 'html-lang-missing'],
  ])
  assert.deepEqual(report.summary, {
    checked: 2,
    errors: 3,
    warnings: 1,
    info: 2,
    pages: 2,
    skipped: 0,
    duplicateGroups: 0,
  })

  // An empty or absent snippet is never grouped, so two blank titles across a
  // site can never be reported as duplicates of each other.
  assert.equal(report.summary.duplicateGroups, 0)
  assert.equal(
    report.findings.find((finding) => finding.ruleId === 'entity-not-decoded').evidence,
    'Half of it &frac12; stays as written.',
  )
})

test('every rule the catalog defines is reachable from the fixtures in this suite', async () => {
  const seen = new Set()
  const configs = [
    example('clean', 'meta.config.json'),
    example('broken', 'meta.config.json'),
    fixture('edge', 'meta.config.json'),
    fixture('lengths', 'meta.config.json'),
    fixture('unicode', 'meta.config.json'),
    fixture('nothing', 'meta.config.json'),
    fixture('incomplete', 'missing-page.config.json'),
    fixture('incomplete', 'too-large.config.json'),
    fixture('incomplete', 'page-limit.config.json'),
    fixture('incomplete', 'not-utf8.config.json'),
    fixture('incomplete', 'head-length.config.json'),
    fixture('incomplete', 'text-length.config.json'),
    fixture('incomplete', 'charset.config.json'),
  ]

  for (const config of configs) {
    const report = await lintMetaSnippets({ config })
    for (const finding of report.findings) seen.add(finding.ruleId)
  }

  const unreachable = Object.keys(RULE_SEVERITY).filter((ruleId) => !seen.has(ruleId))
  assert.deepEqual(unreachable, [])
})

test('all four length rules fire with the counted number and the configured bound', async () => {
  const report = await lintMetaSnippets({ config: fixture('lengths', 'meta.config.json') })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [
      ['build/long.html', 'description-too-long'],
      ['build/long.html', 'title-too-long'],
      ['build/short.html', 'description-too-short'],
      ['build/short.html', 'title-too-short'],
    ],
  )
  assert.equal(report.summary.errors, 4)
  assert.match(report.findings[0].message, /is 161 graphemes long, above the maximum of 120 for this locale/)
  assert.match(report.findings[1].message, /is 72 graphemes long, above the maximum of 60 for this locale/)
  assert.match(report.findings[2].message, /is 10 graphemes long, below the minimum of 70 for this locale/)
  assert.match(report.findings[3].message, /is 5 graphemes long, below the minimum of 20 for this locale/)
})
