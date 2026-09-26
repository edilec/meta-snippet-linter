/**
 * What page content is allowed to do on its way into the report.
 *
 * `excerpt` is the only door between an untrusted build directory and two
 * places a human reads: the JSON report and the stderr summary rendered in a
 * terminal. It is a security control, so it is tested as one rather than
 * trusted because the source says it scrubs. Three guarantees are pinned here,
 * and breaking any of them turns this file red:
 *
 * - no C0, DEL, C1 or line-separator code unit survives into an excerpt, so a
 *   title carrying an ANSI escape sequence cannot repaint or rewrite the
 *   operator's terminal;
 * - an excerpt is bounded on the way out (`EVIDENCE_LIMIT`), so one enormous
 *   description cannot dominate a report;
 * - an excerpt is bounded on the way in (`SCRUB_LIMIT`), so the scrub itself is
 *   bounded work however long the attribute value is.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { EVIDENCE_LIMIT, SCRUB_LIMIT, excerpt } from '../src/rules.mjs'
import { lintMetaSnippets } from '../src/index.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'meta-snippet-linter.mjs')

/**
 * The ranges `excerpt` promises to remove, written as arithmetic so this file
 * holds no control characters of its own.
 */
function isUnprintableCode(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

const ESCAPE = String.fromCharCode(0x1b)
const BELL = String.fromCharCode(0x07)
const CARRIAGE_RETURN = String.fromCharCode(0x0d)
const NEL = String.fromCharCode(0x85)
const LINE_SEPARATOR = String.fromCharCode(0x2028)

/** A title that tries to repaint a terminal and to forge a line of output. */
const HOSTILE_TITLE = `A${ESCAPE}[31mRED${ESCAPE}[0m${CARRIAGE_RETURN}${LINE_SEPARATOR}${NEL}INJECTED${BELL}`
const HOSTILE_EXCERPT = 'A [31mRED [0m INJECTED'

function unprintableIn(text) {
  const found = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (isUnprintableCode(code)) found.push(`0x${code.toString(16)}`)
  }
  return found
}

/**
 * Build a throwaway project whose one page carries the given title.
 *
 * The hostile bytes are written at run time rather than committed, so no
 * fixture in this repository has to contain a control character.
 */
async function withProject(title, body) {
  const root = await mkdtemp(join(tmpdir(), 'meta-snippet-linter-'))
  try {
    await mkdir(join(root, 'build'))
    await writeFile(
      join(root, 'build', 'page.html'),
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>${title}</title>\n` +
        '<meta name="description" content="A description that is comfortably inside the bounds." />\n' +
        '</head>\n<body></body>\n</html>\n',
      'utf8',
    )
    const config = join(root, 'meta.config.json')
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: '1',
        counting: 'graphemes',
        duplicateScope: 'locale',
        defaults: { title: { min: 1, max: 5 }, description: { min: 1, max: 200 } },
        locales: { en: {} },
        pages: [{ path: '/injected', file: 'build/page.html', locale: 'en' }],
      }),
      'utf8',
    )
    return await body(config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('every control character excerpt promises to remove is removed', () => {
  const codes = []
  for (let code = 0x00; code <= 0x9f; code += 1) {
    if (isUnprintableCode(code)) codes.push(code)
  }
  codes.push(0x2028, 0x2029)
  // The ranges themselves, so a narrowed guard is caught as well as a deleted one.
  assert.equal(codes.length, 0x20 + 0x21 + 2)

  for (const code of codes) {
    const scrubbed = excerpt(`A${String.fromCharCode(code)}B`)
    assert.equal(scrubbed, 'A B', `U+${code.toString(16).padStart(4, '0')} survived as ${JSON.stringify(scrubbed)}`)
  }
})

test('a printable character just outside those ranges is kept, so the scrub is not just deleting everything', () => {
  assert.equal(excerpt('A!B'), 'A!B')
  // 0x7e and 0xa0 bracket the DEL/C1 range; 0x2027 and 0x202a bracket the two
  // line separators. A guard widened by one code point is caught here.
  assert.equal(excerpt(`A${String.fromCharCode(0x7e)}B`), 'A~B')
  assert.equal(excerpt(`A${String.fromCharCode(0x2027)}B`), `A${String.fromCharCode(0x2027)}B`)
  assert.equal(excerpt(`A${String.fromCharCode(0x202a)}B`), `A${String.fromCharCode(0x202a)}B`)
  // A no-break space is not a control character; it is flattened as whitespace,
  // which is a different promise and is kept separate on purpose.
  assert.equal(excerpt(`A${String.fromCharCode(0xa0)}B`), 'A B')
})

test('an ANSI escape sequence in a title cannot survive into an excerpt', () => {
  const scrubbed = excerpt(HOSTILE_TITLE)

  assert.equal(scrubbed, HOSTILE_EXCERPT)
  assert.deepEqual(unprintableIn(scrubbed), [])
  // The fixture really is hostile, so the assertion above can fail.
  assert.deepEqual(unprintableIn(HOSTILE_TITLE), ['0x1b', '0x1b', '0xd', '0x2028', '0x85', '0x7'])
})

test('an excerpt is bounded on the way out, and says so when it truncated', () => {
  const exact = excerpt('a'.repeat(EVIDENCE_LIMIT))
  const over = excerpt('a'.repeat(EVIDENCE_LIMIT * 10))

  assert.equal(EVIDENCE_LIMIT, 160)
  assert.equal(exact.length, EVIDENCE_LIMIT)
  assert.doesNotMatch(exact, /\.\.\.$/)
  assert.equal(over, `${'a'.repeat(EVIDENCE_LIMIT)}...`)
  assert.equal(over.length, EVIDENCE_LIMIT + 3)
})

test('an excerpt is bounded on the way in: nothing past SCRUB_LIMIT is ever scanned', () => {
  const tail = 'TAIL-BEYOND-THE-BOUND'

  // One code unit inside the bound the tail is read...
  assert.equal(excerpt(' '.repeat(SCRUB_LIMIT - tail.length) + tail), tail)
  // ...and one code unit past it nothing is, however long the value runs on.
  assert.equal(excerpt(' '.repeat(SCRUB_LIMIT) + tail), '')
  assert.equal(excerpt(' '.repeat(SCRUB_LIMIT * 4) + tail), '')
})

test('a hostile title reaches the report as an excerpt and nothing else', async () => {
  await withProject(HOSTILE_TITLE, async (config) => {
    const report = await lintMetaSnippets({ config })
    const finding = report.findings.find((candidate) => candidate.ruleId === 'title-too-long')

    assert.equal(report.status, 'fail')
    assert.equal(finding.evidence, HOSTILE_EXCERPT)

    const strings = []
    JSON.stringify(report, (key, value) => {
      if (typeof value === 'string') strings.push(value)
      return value
    })
    for (const value of strings) {
      assert.deepEqual(unprintableIn(value), [], `a report string carries control characters: ${JSON.stringify(value)}`)
    }
  })
})

test('the stderr summary an operator reads carries no terminal control sequence', async () => {
  await withProject(HOSTILE_TITLE, async (config) => {
    const result = await run(process.execPath, [CLI, '--config', config]).catch((error) => error)

    assert.equal(result.code, 1)
    assert.match(result.stderr, /^meta-snippet-linter: fail/)
    // Newline is the only control character a rendered summary may contain.
    assert.deepEqual(unprintableIn(result.stderr.replaceAll('\n', '')), [])
    assert.deepEqual(unprintableIn(result.stdout.replaceAll('\n', '')), [])
  })
})
