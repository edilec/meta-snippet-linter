/**
 * The configuration gate, from the side a future edit could open.
 *
 * `validateConfig` is where a run decides what it is measuring. Every guard in
 * it exists because the alternative is a green run that measured the wrong
 * thing: a config written for another schema, a bound key nobody reads, a
 * locale override that makes every snippet permanently too short, a limit of
 * zero. All five guards below could be deleted with the rest of the suite
 * staying green, which is what this file fixes.
 *
 * Each case carries its control: the same configuration without the mistake
 * validates and produces the value the rest of the tool reads.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CONFIG_SCHEMA_VERSION, validateConfig } from '../src/index.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'meta-snippet-linter.mjs')
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)

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

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('a config written for another schema version is refused, whatever shape the version takes', () => {
  const absent = baseConfig()
  delete absent.schemaVersion

  assert.throws(() => validateConfig(baseConfig({ schemaVersion: '2' })), /Unsupported config schemaVersion: 2/)
  assert.throws(() => validateConfig(baseConfig({ schemaVersion: '1.0' })), /Unsupported config schemaVersion: 1\.0/)
  // A number is not the string the schema declares: accepting it would mean
  // "1" and 1 are the same document, and the next version would inherit that.
  assert.throws(() => validateConfig(baseConfig({ schemaVersion: 1 })), /Unsupported config schemaVersion: 1/)
  assert.throws(() => validateConfig(baseConfig({ schemaVersion: null })), /Unsupported config schemaVersion: missing/)
  assert.throws(() => validateConfig(absent), /Unsupported config schemaVersion: missing/)

  assert.equal(CONFIG_SCHEMA_VERSION, '1')
  assert.equal(validateConfig(baseConfig()).schemaVersion, CONFIG_SCHEMA_VERSION)
})

test('an unknown key inside a bounds object is refused, in defaults and in a locale override', () => {
  assert.throws(
    () =>
      validateConfig(
        baseConfig({ defaults: { title: { min: 1, max: 60, maxx: 70 }, description: { min: 1, max: 160 } } }),
      ),
    /Unknown key "maxx" in defaults\.title\. Known keys: min, max/,
  )
  assert.throws(
    () =>
      validateConfig(
        baseConfig({ defaults: { title: { min: 1, max: 60 }, description: { min: 1, max: 160, minimum: 1 } } }),
      ),
    /Unknown key "minimum" in defaults\.description/,
  )
  assert.throws(
    () => validateConfig(baseConfig({ locales: { en: { title: { min: 1, maxx: 70 } } } })),
    /Unknown key "maxx" in locales\.en\.title/,
  )
  assert.throws(
    () => validateConfig(baseConfig({ locales: { en: { description: { maxx: 70 } } } })),
    /Unknown key "maxx" in locales\.en\.description/,
  )

  // The control: the two keys that are known are accepted in both positions.
  assert.deepEqual(validateConfig(baseConfig()).defaults.title, { min: 1, max: 60 })
  assert.deepEqual(
    validateConfig(baseConfig({ locales: { en: { title: { min: 2, max: 50 } } } })).locales.get('en').title,
    { min: 2, max: 50 },
  )
})

test('a locale override whose merged min exceeds its merged max is refused', () => {
  // Accepting this would make every title in the locale permanently too short:
  // a bound nobody could satisfy, applied to every page, reported as a real
  // failure of the site rather than of the configuration.
  assert.throws(
    () => validateConfig(baseConfig({ locales: { en: { title: { min: 100 } } } })),
    /locales\.en\.title\.min must not exceed locales\.en\.title\.max/,
  )
  assert.throws(
    () => validateConfig(baseConfig({ locales: { en: { description: { max: 0 } } } })),
    /locales\.en\.description\.min must not exceed locales\.en\.description\.max/,
  )

  // The control: an override that stays inside the inherited bound merges.
  assert.deepEqual(validateConfig(baseConfig({ locales: { en: { title: { min: 40 } } } })).locales.get('en').title, {
    min: 40,
    max: 60,
  })
})

test('a limit value that is not a positive integer is refused, from the config and from an override', () => {
  const rejected = [0, -5, 1.5, '5', null, true, Number.NaN, Number.POSITIVE_INFINITY]

  for (const value of rejected) {
    assert.throws(
      () => validateConfig(baseConfig({ limits: { maxTags: value } })),
      /limits\.maxTags must be a positive integer/,
      `config limits.maxTags = ${String(value)}`,
    )
    assert.throws(
      () => validateConfig(baseConfig(), { limits: { maxTags: value } }),
      /limits\.maxTags must be a positive integer/,
      `override limits.maxTags = ${String(value)}`,
    )
  }

  // The control: a positive integer is carried through from either source.
  assert.deepEqual(validateConfig(baseConfig({ limits: { maxTags: 7 } })).limits, { maxTags: 7 })
  assert.deepEqual(validateConfig(baseConfig(), { limits: { maxTags: 7 } }).limits, { maxTags: 7 })
})

test('both refusals reach the command line as a configuration error, with empty stdout', async () => {
  const cases = [
    ['schema-version.config.json', /Config error: Unsupported config schemaVersion: 2/],
    ['limit-value.config.json', /Config error: limits\.maxTags must be a positive integer/],
    ['bound-key.config.json', /Config error: Unknown key "maxx" in defaults\.title/],
    ['locale-bounds.config.json', /Config error: locales\.en\.title\.min must not exceed locales\.en\.title\.max/],
  ]

  for (const [name, expected] of cases) {
    const result = await cli(['--config', fixture('invalid', name)])

    assert.equal(result.code, 2, name)
    assert.equal(result.stdout, '', name)
    assert.match(result.stderr, expected, name)
  }
})
