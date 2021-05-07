/**
 * Every path that can set `incomplete`, pinned.
 *
 * The failure this file exists to prevent: deleting one `incomplete = true`
 * assignment and watching an entirely unread input report `pass` with the suite
 * still green. Each case below asserts the status, so removing the assignment
 * turns the case red. Three of them carry only warning-severity findings, which
 * is where the flag is the *only* thing standing between the run and a pass:
 * those are asserted with `errors: 0` so the point cannot be missed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exitCodeFor, lintMetaSnippets } from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)

const rules = (report) => report.findings.map((finding) => finding.ruleId)

async function incompleteRun(name, options = {}) {
  const report = await lintMetaSnippets({ config: fixture('incomplete', name), ...options })
  assert.equal(report.status, 'incomplete', `${name} must not report ${report.status}`)
  assert.equal(exitCodeFor(report), 2, name)
  return report
}

test('a page that was never built is incomplete, not a pass', async () => {
  const report = await incompleteRun('missing-page.config.json')

  assert.deepEqual(rules(report), ['page-unreadable'])
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.summary.pages, 2)
  assert.match(report.findings[0].message, /could not be read \(ENOENT\)/)
})

test('a page above maxHtmlBytes is incomplete, and the limit is named', async () => {
  const report = await incompleteRun('too-large.config.json')

  assert.deepEqual(rules(report).sort(), ['nothing-checked', 'page-too-large'])
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'page-too-large').message,
    /above the configured maxHtmlBytes limit of 16/,
  )
})

test('more pages than maxPages is incomplete, and nothing is read', async () => {
  const report = await incompleteRun('page-limit.config.json')

  assert.deepEqual(rules(report).sort(), ['nothing-checked', 'page-limit-exceeded'])
  assert.equal(report.summary.pages, 2)
  assert.equal(report.summary.checked, 0)
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'page-limit-exceeded').message,
    /above the configured maxPages limit of 1\. No page was read\./,
  )
})

test('bytes that are not UTF-8 are incomplete, never a pass', async () => {
  const report = await incompleteRun('not-utf8.config.json')

  assert.deepEqual(rules(report).sort(), ['nothing-checked', 'page-not-utf8'])
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'page-not-utf8').message,
    /is not valid UTF-8, so nothing was decoded from it/,
  )
})

test('a page that legitimately contains U+FFFD decodes and passes', async () => {
  // The inverse of the case above, and the defect it guards: encoding validity
  // is decided by the decoder, never inferred from the decoded text.
  const report = await lintMetaSnippets({ config: fixture('incomplete', 'replacement.config.json') })

  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.checked, 1)
  assert.deepEqual(report.findings, [])
})

test('a head that ran past maxHeadLength is incomplete even though nothing is an error', async () => {
  const report = await incompleteRun('head-length.config.json')

  assert.deepEqual(rules(report), ['head-scan-truncated'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.findings[0].severity, 'warning')
  assert.match(report.findings[0].message, /hit the configured maxHeadLength limit of 400/)
})

test('a head that ran past maxTags is incomplete and names that limit instead', async () => {
  const report = await incompleteRun('max-tags.config.json')

  assert.ok(rules(report).includes('head-scan-truncated'))
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'head-scan-truncated').message,
    /hit the configured maxTags limit of 4/,
  )
})

test('a snippet above maxTextLength is incomplete even though nothing is an error', async () => {
  const report = await incompleteRun('text-length.config.json')

  assert.deepEqual(rules(report), ['text-truncated', 'text-truncated'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 2)
  for (const finding of report.findings) {
    assert.equal(finding.severity, 'warning')
    assert.match(finding.message, /above the configured maxTextLength limit of 8. It was neither measured nor compared./)
  }
  // A snippet that was not fully seen must not be grouped with anything.
  assert.equal(report.summary.duplicateGroups, 0)
})

test('a declared charset this tool does not support is incomplete even though nothing is an error', async () => {
  const report = await incompleteRun('charset.config.json')

  assert.deepEqual(rules(report), ['charset-not-utf8'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.findings[0].severity, 'warning')
  assert.match(report.findings[0].message, /declares charset "iso-8859-1"/)
})

test('every limit is enforced from the config and from an option override', async () => {
  const overrides = [
    ['maxPages', 1, 'page-limit-exceeded'],
    ['maxHtmlBytes', 16, 'page-too-large'],
    ['maxHeadLength', 120, 'head-scan-truncated'],
    ['maxTags', 3, 'head-scan-truncated'],
    ['maxTextLength', 8, 'text-truncated'],
  ]

  for (const [limit, value, expected] of overrides) {
    const report = await lintMetaSnippets({
      config: fixture('incomplete', 'missing-page.config.json'),
      limits: { [limit]: value },
    })
    assert.equal(report.status, 'incomplete', limit)
    assert.ok(rules(report).includes(expected), `${limit} should produce ${expected}, got ${rules(report).join(', ')}`)
  }
})

test('the same inputs without the limits produce no limit finding, so the cases above are not vacuous', async () => {
  const report = await lintMetaSnippets({ config: fixture('incomplete', 'missing-page.config.json') })

  assert.deepEqual(rules(report), ['page-unreadable'])
})
