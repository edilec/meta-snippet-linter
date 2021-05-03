import assert from 'node:assert/strict'
import test from 'node:test'

import { scanHead } from '../src/html.mjs'

const LIMITS = { maxHeadLength: 100000, maxTags: 1000 }

function head(body) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n${body}\n</head>\n<body><p>x</p></body>\n</html>\n`
}

test('the title and description are read with their source positions', () => {
  const result = scanHead(head('<title>Edilec</title>\n<meta name="description" content="A description." />'), LIMITS)

  assert.equal(result.title.text, 'Edilec')
  assert.deepEqual(result.title.position, { line: 4, column: 1 })
  assert.equal(result.description.text, 'A description.')
  assert.deepEqual(result.description.position, { line: 5, column: 1 })
  assert.equal(result.headEnded, true)
  assert.equal(result.truncated, null)
})

test('a title inside a script is not the document title', () => {
  const result = scanHead(
    head('<script>const decoy = "<title>fake</title>";</script>\n<title>Real</title>'),
    LIMITS,
  )

  assert.equal(result.title.text, 'Real')
  assert.equal(result.titleElements, 1)
})

test('a commented-out title is ignored', () => {
  const result = scanHead(head('<!-- <title>commented</title> -->\n<title>Real</title>'), LIMITS)

  assert.equal(result.title.text, 'Real')
  assert.equal(result.titleElements, 1)
})

test('a greater-than inside a quoted attribute does not end the tag', () => {
  const result = scanHead(head('<meta name="description" content="5 > 3 and 2 < 4" />'), LIMITS)

  assert.equal(result.description.text, '5 > 3 and 2 < 4')
})

test('repeated elements are counted and the first one wins', () => {
  const result = scanHead(
    head('<title>First</title>\n<title>Second</title>\n<meta name="description" content="one" />\n<meta name="Description" content="two" />'),
    LIMITS,
  )

  assert.equal(result.title.text, 'First')
  assert.equal(result.titleElements, 2)
  assert.equal(result.description.text, 'one')
  assert.equal(result.descriptionElements, 2)
})

test('a meta description with no content attribute is present but empty', () => {
  const result = scanHead(head('<title>x</title>\n<meta name="description" />'), LIMITS)

  assert.equal(result.descriptionElements, 1)
  assert.equal(result.description.text, null)
})

test('the charset is read from either spelling', () => {
  const direct = scanHead(head('<meta charset="iso-8859-1" /><title>x</title>'), LIMITS)
  const equivalent = scanHead(
    head('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252" /><title>x</title>'),
    LIMITS,
  )

  assert.equal(direct.charset.value, 'iso-8859-1')
  assert.equal(equivalent.charset.value, 'windows-1252')
})

test('scanning stops at the body even when the head was never closed', () => {
  const source = '<html lang="en"><title>x</title><body><h1>y</h1><title>not counted</title></body>'
  const result = scanHead(source, LIMITS)

  assert.equal(result.headEnded, true)
  assert.equal(result.titleElements, 1)
  assert.equal(result.truncated, null)
})

test('the lang attribute is read from the html element with its position', () => {
  const result = scanHead(head('<title>x</title>'), LIMITS)

  assert.equal(result.lang.value, 'en')
  assert.deepEqual(result.lang.position, { line: 2, column: 1 })
})

test('running past maxHeadLength before the head ends is reported, not silently truncated', () => {
  const source = head(`<title>x</title>${'<link rel="preload" href="/a.js" />'.repeat(200)}`)
  const result = scanHead(source, { maxHeadLength: 120, maxTags: 1000 })

  assert.equal(result.truncated, 'maxHeadLength')
  assert.equal(result.headEnded, false)
})

test('running past maxTags before the head ends is reported', () => {
  const source = head(`<title>x</title>${'<link rel="preload" href="/a.js" />'.repeat(200)}`)
  const result = scanHead(source, { maxHeadLength: 100000, maxTags: 5 })

  assert.equal(result.truncated, 'maxTags')
  assert.equal(result.tagsScanned, 6)
})

test('a document shorter than the bound whose head simply never closes is not truncated', () => {
  const result = scanHead('<html lang="en"><head><title>x</title>', { maxHeadLength: 100000, maxTags: 1000 })

  assert.equal(result.truncated, null)
  assert.equal(result.title.text, 'x')
})

test('scanHead refuses limits that are not positive integers', () => {
  assert.throws(() => scanHead('<title>x</title>', { maxHeadLength: 0, maxTags: 1 }), /maxHeadLength/)
  assert.throws(() => scanHead('<title>x</title>', { maxHeadLength: 1, maxTags: 0 }), /maxTags/)
})
