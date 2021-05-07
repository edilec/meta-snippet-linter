import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'bin', 'meta-snippet-linter.mjs')
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)
const example = (...parts) => join(ROOT, 'examples', ...parts)

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const rules = (report) => report.findings.map((finding) => finding.ruleId)

test('--help explains the tool, prints on stdout and exits 0', async () => {
  const result = await cli(['--help'])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /^meta-snippet-linter 0\.1\.0/)
  assert.match(result.stdout, /not search-engine guarantees/)
  assert.match(result.stdout, /--counting UNIT/)
  assert.match(result.stdout, /--duplicate-scope S/)
  assert.match(result.stdout, /--max-text-length N/)
  assert.equal(result.stderr, '')
})

test('--version matches the published package version', async () => {
  const result = await cli(['--version'])
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

  assert.equal(result.code, 0)
  assert.equal(result.stdout, `${manifest.version}\n`)
})

test('the clean example exits 0 with a parseable report on stdout and a summary on stderr', async () => {
  const result = await cli(['--config', example('clean', 'meta.config.json')])
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 0)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'meta-snippet-linter')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 3)
  assert.deepEqual(report.findings, [])
  assert.match(result.stderr, /^meta-snippet-linter: pass/)
  assert.match(result.stderr, /note: Length bounds are house-style heuristics/)
})

test('--json keeps stderr empty and leaves stdout parseable', async () => {
  const result = await cli(['--config', example('clean', 'meta.config.json'), '--json'])

  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('the broken example exits 1 and reports every page it measured', async () => {
  const result = await cli(['--config', example('broken', 'meta.config.json'), '--json'])
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.pages, 5)
  assert.equal(report.summary.checked, 4)
  assert.deepEqual(rules(report), [
    'description-missing',
    'title-too-long',
    'description-duplicate',
    'title-duplicate',
    'title-too-short',
    'locale-not-declared',
    'description-duplicate',
    'title-duplicate',
    'title-too-short',
    'title-repeated-element',
    'html-lang-mismatch',
  ])
})

test('an unreadable input exits 2 with an incomplete report on stdout', async () => {
  const result = await cli(['--config', fixture('incomplete', 'missing-page.config.json'), '--json'])
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rules(report), ['page-unreadable'])
  assert.equal(report.findings[0].location.file, 'build/never-built.html')
})

test('a configuration error exits 2 with empty stdout and the message on stderr', async () => {
  const cases = [
    [['--config', fixture('invalid', 'unknown-key.config.json')], /Unknown config key "duplcateScope"/],
    [['--config', fixture('invalid', 'unknown-limit.config.json')], /Unknown limit "maxPage"/],
    [['--config', fixture('invalid', 'no-counting.config.json')], /counting must be one of/],
    [['--config', fixture('invalid', 'not-json.config.json')], /not valid JSON/],
  ]

  for (const [args, expected] of cases) {
    const result = await cli(args)
    assert.equal(result.code, 2, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
    assert.match(result.stderr, expected)
  }
})

test('bad usage exits 2 with empty stdout and the help text', async () => {
  const cases = [
    [[], /--config is required/],
    [['--config'], /--config requires a value/],
    [['--config', example('clean', 'meta.config.json'), '--verbose'], /Unknown option "--verbose"/],
    [['--config', example('clean', 'meta.config.json'), '--max-pages', '0'], /--max-pages requires a positive integer/],
    [['--config', example('clean', 'meta.config.json'), '--max-pages', 'lots'], /--max-pages requires a positive integer/],
  ]

  for (const [args, expected] of cases) {
    const result = await cli(args)
    assert.equal(result.code, 2, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
    assert.match(result.stderr, expected)
  }
})

test('stdout is byte-identical across runs', async () => {
  const first = await cli(['--config', example('broken', 'meta.config.json'), '--json'])
  const second = await cli(['--config', example('broken', 'meta.config.json'), '--json'])

  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 0)
})

test('every documented limit flag is wired through to the check', async () => {
  const cases = [
    [['--max-pages', '1'], 'page-limit-exceeded'],
    [['--max-html-bytes', '16'], 'page-too-large'],
    [['--max-head-length', '120'], 'head-scan-truncated'],
    [['--max-tags', '3'], 'head-scan-truncated'],
    [['--max-text-length', '8'], 'text-truncated'],
  ]

  for (const [flag, expected] of cases) {
    const result = await cli(['--config', example('clean', 'meta.config.json'), '--json', ...flag])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 2, flag.join(' '))
    assert.equal(report.status, 'incomplete', flag.join(' '))
    assert.ok(rules(report).includes(expected), `${flag.join(' ')} should produce ${expected}`)
  }

  // The control: without any flag the same example is clean, so each case above
  // is caused by the flag and not by the fixture.
  const control = await cli(['--config', example('clean', 'meta.config.json'), '--json'])
  assert.equal(control.code, 0)
  assert.deepEqual(JSON.parse(control.stdout).findings, [])
})

test('--counting and --duplicate-scope are wired through', async () => {
  const graphemes = await cli(['--config', fixture('counting', 'meta.config.json'), '--json'])
  const codePoints = await cli(['--config', fixture('counting', 'meta.config.json'), '--json', '--counting', 'codePoints'])
  const withinLocale = await cli(['--config', fixture('scope', 'meta.config.json'), '--json'])
  const acrossSite = await cli(['--config', fixture('scope', 'meta.config.json'), '--json', '--duplicate-scope', 'site'])

  assert.equal(graphemes.code, 0)
  assert.deepEqual(rules(JSON.parse(graphemes.stdout)), [])
  assert.equal(codePoints.code, 1)
  assert.deepEqual(rules(JSON.parse(codePoints.stdout)), ['title-too-long'])

  assert.equal(withinLocale.code, 0)
  assert.equal(JSON.parse(withinLocale.stdout).summary.duplicateGroups, 0)
  assert.equal(acrossSite.code, 1)
  assert.equal(JSON.parse(acrossSite.stdout).summary.duplicateGroups, 1)
})

test('--root decides where page paths resolve', async () => {
  const correct = await cli(['--config', example('clean', 'meta.config.json'), '--json', '--root', example('clean')])
  const wrong = await cli(['--config', example('clean', 'meta.config.json'), '--json', '--root', example()])

  assert.equal(correct.code, 0)
  assert.equal(JSON.parse(correct.stdout).summary.checked, 3)
  assert.equal(wrong.code, 2)
  assert.deepEqual(rules(JSON.parse(wrong.stdout)), [
    'nothing-checked',
    'page-unreadable',
    'page-unreadable',
    'page-unreadable',
  ])
})

test('an unsupported counting unit or scope on the command line is a configuration error', async () => {
  const badUnit = await cli(['--config', example('clean', 'meta.config.json'), '--counting', 'bytes'])
  const badScope = await cli(['--config', example('clean', 'meta.config.json'), '--duplicate-scope', 'page'])

  assert.equal(badUnit.code, 2)
  assert.equal(badUnit.stdout, '')
  assert.match(badUnit.stderr, /counting must be one of graphemes, codePoints, utf16CodeUnits/)
  assert.equal(badScope.code, 2)
  assert.equal(badScope.stdout, '')
  assert.match(badScope.stderr, /duplicateScope must be one of locale, site/)
})
