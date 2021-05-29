import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { ConfigError, lintMetaSnippets, serializeReport } from '../src/index.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'bin', 'meta-snippet-linter.mjs')
const fixture = (...parts) => join(HERE, 'fixtures', ...parts)

/** The string planted in the out-of-root file. It must never reach a report. */
const MARKER = 'OUT-OF-ROOT-MARKER'

/**
 * The same trick played inside the root, where it is allowed to work: a page
 * this tool may legitimately read, carrying a marker of its own into the
 * report as evidence.
 */
const INSIDE_MARKER = 'IN-ROOT-MARKER'

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('a page inside the root is read normally, so confinement is not refusing everything', async () => {
  const report = await lintMetaSnippets({ config: fixture('confinement', 'inside.config.json') })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('a symbolic link to a file outside the root is refused and never read', async () => {
  await assert.rejects(
    () => lintMetaSnippets({ config: fixture('confinement', 'symlink-file.config.json') }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.rule, 'input-escapes-root')
      assert.doesNotMatch(error.message, new RegExp(MARKER))
      return true
    },
  )
})

test('a symbolic link to a directory outside the root is refused and never read', async () => {
  await assert.rejects(
    () => lintMetaSnippets({ config: fixture('confinement', 'symlink-dir.config.json') }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.rule, 'input-escapes-root')
      assert.doesNotMatch(error.message, new RegExp(MARKER))
      return true
    },
  )
})

test('a path spelled out of the root is refused before anything is opened', async () => {
  await assert.rejects(
    () => lintMetaSnippets({ config: fixture('confinement', 'dotdot.config.json') }),
    (error) => {
      assert.equal(error.rule, 'input-outside-root')
      return true
    },
  )
})

test('an absolute path is refused', async () => {
  await assert.rejects(
    () => lintMetaSnippets({ config: fixture('confinement', 'absolute.config.json') }),
    (error) => {
      assert.equal(error.rule, 'input-not-relative')
      return true
    },
  )
})

test('no out-of-root content reaches stdout, stderr or any serialized report', async () => {
  const escapes = ['symlink-file', 'symlink-dir', 'dotdot', 'absolute']

  for (const name of escapes) {
    const result = await cli(['--config', fixture('confinement', `${name}.config.json`)])

    assert.equal(result.code, 2, name)
    // A configuration error had no subject, so it produces no report at all.
    assert.equal(result.stdout, '', name)
    assert.doesNotMatch(result.stdout, new RegExp(MARKER), name)
    assert.doesNotMatch(result.stderr, new RegExp(MARKER), name)
    assert.match(result.stderr, /^Config error: /, name)
  }
})

test('the out-of-root fixture really does hold the marker, so the checks above can fail', async () => {
  const { readFile } = await import('node:fs/promises')
  const planted = await readFile(fixture('outside-root', 'secret.html'), 'utf8')

  assert.match(planted, new RegExp(MARKER))

  // And the control, which needs teeth of its own: a report over a page inside
  // the root *does* quote that page's text back as evidence. A clean pass would
  // have proved nothing -- it carries no page text at all, so the out-of-root
  // marker would be absent from it for a reason that has nothing to do with
  // confinement.
  const report = await lintMetaSnippets({ config: fixture('confinement', 'evidence.config.json') })
  const serialized = serializeReport(report)

  assert.equal(report.status, 'fail')
  assert.equal(report.findings.length, 1)
  assert.match(serialized, new RegExp(INSIDE_MARKER))
  assert.doesNotMatch(serialized, new RegExp(MARKER))
})
