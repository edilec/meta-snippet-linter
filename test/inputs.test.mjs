/**
 * What counts as a page this tool will read.
 *
 * `readPage` opens only regular files. Anything else a build directory can
 * contain -- a directory, a named pipe, a device node -- is refused as
 * "not a regular file" before a byte is requested from it, and the run is
 * `incomplete` rather than a pass.
 *
 * The gate is not tidiness. Opening a named pipe blocks until something writes
 * to it, so without the gate a single FIFO planted where a page should be hangs
 * the linter for as long as anyone is willing to wait; and a pipe that *is*
 * being written to would be measured as though it were the shipped page. Both
 * are pinned here: the directory case asserts the refusal says which kind it
 * was, and the pipe case runs the real CLI under a hard timeout, so a linter
 * that waits instead of refusing fails rather than hangs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { exitCodeFor, lintMetaSnippets } from '../src/index.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'meta-snippet-linter.mjs')

/** How long the CLI may take before a waiting linter is called a hang. */
const PATIENCE = 8000

/**
 * A throwaway project whose single page is whatever `plant` puts at
 * `build/page.html`.
 */
async function withProject(plant, body) {
  const root = await mkdtemp(join(tmpdir(), 'meta-snippet-linter-'))
  try {
    await mkdir(join(root, 'build'))
    await plant(join(root, 'build', 'page.html'))
    const config = join(root, 'meta.config.json')
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: '1',
        counting: 'graphemes',
        duplicateScope: 'locale',
        defaults: { title: { min: 1, max: 60 }, description: { min: 1, max: 160 } },
        locales: { en: {} },
        pages: [{ path: '/planted', file: 'build/page.html', locale: 'en' }],
      }),
      'utf8',
    )
    return await body(config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const HTML =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>A planted page</title>\n' +
  '<meta name="description" content="A description that is comfortably inside the bounds." />\n' +
  '</head>\n<body></body>\n</html>\n'

test('a real file in the same position is read normally, so the refusals below are about the kind of file', async () => {
  await withProject(
    (target) => writeFile(target, HTML, 'utf8'),
    async (config) => {
      const report = await lintMetaSnippets({ config })

      assert.equal(report.status, 'pass')
      assert.equal(report.summary.checked, 1)
      assert.deepEqual(report.findings, [])
    },
  )
})

test('a directory where a page should be is refused as not a regular file', async () => {
  await withProject(
    (target) => mkdir(target),
    async (config) => {
      const report = await lintMetaSnippets({ config })

      assert.equal(report.status, 'incomplete')
      assert.equal(exitCodeFor(report), 2)
      assert.equal(report.summary.checked, 0)
      assert.deepEqual(
        report.findings.map((finding) => finding.ruleId).sort(),
        ['nothing-checked', 'page-unreadable'],
      )
      // The reason names the gate. A tool that fell through to reading it would
      // report the operating system's EISDIR instead, which is the same verdict
      // reached by luck rather than by refusing.
      assert.match(
        report.findings.find((finding) => finding.ruleId === 'page-unreadable').message,
        /could not be read \(not a regular file\)/,
      )
    },
  )
})

test('a named pipe where a page should be is refused, not waited on', { skip: process.platform === 'win32' }, async () => {
  await withProject(
    async (target) => {
      await run('mkfifo', [target])
    },
    async (config) => {
      // The real CLI under a hard timeout: opening a FIFO for reading blocks
      // until a writer appears, and no writer is ever coming. A linter that
      // opens it is killed here and fails this test instead of hanging the run.
      const result = await run(process.execPath, [CLI, '--config', config, '--json'], {
        timeout: PATIENCE,
      }).then(
        (ok) => ({ code: 0, killed: false, stdout: ok.stdout, stderr: ok.stderr }),
        (error) => ({
          code: error.code ?? null,
          killed: error.killed === true,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
        }),
      )

      assert.equal(result.killed, false, 'the linter waited on the pipe instead of refusing it')
      assert.equal(result.code, 2)

      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(
        report.findings.map((finding) => finding.ruleId).sort(),
        ['nothing-checked', 'page-unreadable'],
      )
      assert.match(
        report.findings.find((finding) => finding.ruleId === 'page-unreadable').message,
        /could not be read \(not a regular file\)/,
      )
    },
  )
})
