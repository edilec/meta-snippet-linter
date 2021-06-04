/**
 * What a `JSON.parse` failure may not echo.
 *
 * `excerpt` exists because page content is data and is never echoed at length.
 * A parse failure walked straight past it. V8 reports one two ways and one of
 * them quotes the input: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not
 * valid JSON`. So a config file short enough to be only a credential was
 * reproduced in full on stderr by `The config is not valid JSON: ...`, which
 * is the diagnostic every malformed or untrusted config takes.
 *
 * Excerpting the message would not have helped: the quoted span sits at the
 * *front*, so cutting from the end removes the position and keeps the input.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/index.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'meta-snippet-linter.mjs')

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a window around the offending
 * character, so a secret in the middle of a document leaks from its middle.
 * Asserting only on the whole string would pass against output that printed
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n')
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length)
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`)
    }
  }
}

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Write `text` as the config of a throwaway directory and run the real binary. */
async function runConfig(text, extraArgs = []) {
  const base = await mkdtemp(join(tmpdir(), 'meta-snippet-linter-parse-'))
  try {
    const config = join(base, 'meta.config.json')
    await writeFile(config, text)
    return await cli(['--config', config, ...extraArgs])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a config that is only a credential is not echoed back', async () => {
  const { code, stdout, stderr } = await runConfig(CANARY)
  assert.equal(code, 2)
  assert.match(stderr, /The config is not valid JSON/)
  assertNoLeak(CANARY, stdout, stderr)
})

test('a config that is only a credential is not echoed back in --json mode either', async () => {
  const { stdout, stderr } = await runConfig(CANARY, ['--json'])
  assertNoLeak(CANARY, stdout, stderr)
})

test("a secret longer than V8's quoting window does not leak its prefix either", async () => {
  const { stdout, stderr } = await runConfig(LONG_SECRET)
  assertNoLeak(LONG_SECRET, stdout, stderr)
  assert.equal(stderr.includes('password=h'), false)
})

test('a secret sitting mid-config does not leak through the windowed form', async () => {
  // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`: the
  // shape that quotes a window rather than a leading prefix.
  const { stdout, stderr } = await runConfig(`[ }${CANARY}]`)
  assertNoLeak(CANARY, stdout, stderr)
})

test('the position, line and column of a parse failure survive the fix', async () => {
  const { stderr } = await runConfig('{"schemaVersion": "1" "pages": []}')
  assert.match(stderr, /at position 22 \(line 1 column 23\)/)
})

test('a parse failure still names the token: a diagnostic that says nothing is its own defect', async () => {
  const { stderr } = await runConfig(CANARY)
  assert.match(stderr, /unexpected token 'A'/)
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('{"schemaVersion": "1" "pages": []}'),
    "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start")
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start")
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}'")
})

test('parseFailureDetail refuses a config whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail scrubs a control character that arrives as the token', () => {
  // V8 names the offending character, and that character came from the input.
  let detail
  try {
    JSON.parse(String.fromCharCode(0x1b))
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail.includes(String.fromCharCode(0x1b)), false)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON')
})
