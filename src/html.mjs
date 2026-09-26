/**
 * A bounded scanner for the part of a built page that carries its snippet.
 *
 * This is deliberately not an HTML parser. It reads forward through the
 * document until the head ends, recognising comments, doctypes, raw-text
 * elements and quoted attribute values well enough that a `>` inside an
 * attribute or a `<title>` inside a script cannot mislead it — and it stops at
 * the first explicit limit rather than reading whatever it was handed.
 *
 * What it does not do is documented as a non-goal: it does not build a tree, it
 * does not execute anything, it does not resolve a `<base>` and it does not
 * follow a client-side router. A title written by JavaScript after load is a
 * title this tool cannot see.
 */

import { isAsciiWhitespace } from './count.mjs'

const LESS_THAN = 0x3c
const GREATER_THAN = 0x3e
const SLASH = 0x2f
const EQUALS = 0x3d
const QUOTE = 0x22
const APOSTROPHE = 0x27

/** Elements whose content is raw text and must be skipped, not scanned. */
const RAW_TEXT = Object.freeze(['script', 'style', 'template', 'noscript', 'textarea'])

const MAX_TAG_NAME = 32

function isNameStart(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)
}

function isNameChar(code) {
  return (
    isNameStart(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x5f ||
    code === 0x3a
  )
}

/** Line start offsets, so a character index can become a 1-based position. */
function lineStartsOf(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) starts.push(index + 1)
  }
  return starts
}

function positionOf(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= index) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: index - starts[low] + 1 }
}

/** The index of the `<` opening a close tag for `name`, or -1. */
function findCloseTag(lowered, name, from) {
  const needle = `</${name}`
  let cursor = from
  while (cursor < lowered.length) {
    const hit = lowered.indexOf(needle, cursor)
    if (hit < 0) return -1
    const after = lowered.charCodeAt(hit + needle.length)
    if (
      Number.isNaN(after) ||
      isAsciiWhitespace(after) ||
      after === SLASH ||
      after === GREATER_THAN
    ) {
      return hit
    }
    cursor = hit + needle.length
  }
  return -1
}

/** The index of the `>` ending a tag that began at `from`, or -1. */
function findTagEnd(source, from) {
  let quote = 0
  for (let index = from; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (quote !== 0) {
      if (code === quote) quote = 0
      continue
    }
    if (code === QUOTE || code === APOSTROPHE) quote = code
    else if (code === GREATER_THAN) return index
  }
  return -1
}

function parseAttributes(source, start, end) {
  const attributes = new Map()
  let index = start
  while (index < end) {
    const code = source.charCodeAt(index)
    if (isAsciiWhitespace(code) || code === SLASH) {
      index += 1
      continue
    }
    const nameStart = index
    while (index < end) {
      const current = source.charCodeAt(index)
      if (isAsciiWhitespace(current) || current === EQUALS || current === SLASH || current === GREATER_THAN) break
      index += 1
    }
    if (index === nameStart) {
      index += 1
      continue
    }
    const name = source.slice(nameStart, index).toLowerCase()
    while (index < end && isAsciiWhitespace(source.charCodeAt(index))) index += 1
    let value = ''
    if (index < end && source.charCodeAt(index) === EQUALS) {
      index += 1
      while (index < end && isAsciiWhitespace(source.charCodeAt(index))) index += 1
      const opening = source.charCodeAt(index)
      if (opening === QUOTE || opening === APOSTROPHE) {
        index += 1
        const valueStart = index
        while (index < end && source.charCodeAt(index) !== opening) index += 1
        value = source.slice(valueStart, index)
        index += 1
      } else {
        const valueStart = index
        while (index < end) {
          const current = source.charCodeAt(index)
          if (isAsciiWhitespace(current) || current === GREATER_THAN) break
          index += 1
        }
        value = source.slice(valueStart, index)
      }
    }
    // First wins, matching how a browser treats a repeated attribute.
    if (!attributes.has(name)) attributes.set(name, value)
  }
  return attributes
}

function charsetFromMeta(attributes) {
  if (attributes.has('charset')) return attributes.get('charset').trim()
  const equivalent = (attributes.get('http-equiv') ?? '').trim().toLowerCase()
  if (equivalent !== 'content-type') return null
  const content = attributes.get('content') ?? ''
  const marker = content.toLowerCase().indexOf('charset=')
  if (marker < 0) return null
  const tail = content.slice(marker + 'charset='.length).trim()
  let end = 0
  while (end < tail.length) {
    const code = tail.charCodeAt(end)
    if (isAsciiWhitespace(code) || code === 0x3b || code === QUOTE || code === APOSTROPHE) break
    end += 1
  }
  return tail.slice(0, end)
}

/**
 * Scan the head of one decoded document.
 *
 * Returns what was found and, when a limit stopped the scan, which limit. A
 * truncated scan is never presented as an absence: the caller turns
 * `truncated` into an `incomplete` report, because "no description before the
 * limit" and "no description" are different facts.
 */
export function scanHead(source, limits) {
  const maxHeadLength = limits.maxHeadLength
  const maxTags = limits.maxTags
  if (!Number.isInteger(maxHeadLength) || maxHeadLength < 1) {
    throw new RangeError('maxHeadLength must be a positive integer')
  }
  if (!Number.isInteger(maxTags) || maxTags < 1) {
    throw new RangeError('maxTags must be a positive integer')
  }

  const bounded = source.length > maxHeadLength ? source.slice(0, maxHeadLength) : source
  const boundedByLength = source.length > maxHeadLength
  const lowered = bounded.toLowerCase()
  const starts = lineStartsOf(bounded)
  const result = {
    title: null,
    titleElements: 0,
    description: null,
    descriptionElements: 0,
    lang: null,
    charset: null,
    headEnded: false,
    truncated: null,
    tagsScanned: 0,
  }

  let index = 0
  while (index < bounded.length) {
    const open = bounded.indexOf('<', index)
    if (open < 0) break
    if (lowered.startsWith('<!--', open)) {
      const close = bounded.indexOf('-->', open + 4)
      if (close < 0) break
      index = close + 3
      continue
    }
    if (lowered.startsWith('<!', open) || lowered.startsWith('<?', open)) {
      const close = findTagEnd(bounded, open + 2)
      if (close < 0) break
      index = close + 1
      continue
    }
    const closing = lowered.startsWith('</', open)
    const nameStart = open + (closing ? 2 : 1)
    if (!isNameStart(bounded.charCodeAt(nameStart))) {
      index = open + 1
      continue
    }
    let nameEnd = nameStart
    while (nameEnd < bounded.length && nameEnd - nameStart < MAX_TAG_NAME && isNameChar(bounded.charCodeAt(nameEnd))) {
      nameEnd += 1
    }
    const name = lowered.slice(nameStart, nameEnd)
    const tagEnd = findTagEnd(bounded, nameEnd)
    if (tagEnd < 0) break

    result.tagsScanned += 1
    if (result.tagsScanned > maxTags) {
      result.truncated = 'maxTags'
      return result
    }

    if (closing) {
      if (name === 'head') {
        result.headEnded = true
        return result
      }
      index = tagEnd + 1
      continue
    }
    if (name === 'body') {
      result.headEnded = true
      return result
    }

    const attributes = parseAttributes(bounded, nameEnd, tagEnd)

    if (name === 'html') {
      if (result.lang === null && attributes.has('lang')) {
        result.lang = { value: attributes.get('lang').trim(), position: positionOf(starts, open) }
      }
      index = tagEnd + 1
      continue
    }

    if (name === 'title') {
      const close = findCloseTag(lowered, 'title', tagEnd + 1)
      const textEnd = close < 0 ? bounded.length : close
      result.titleElements += 1
      if (result.title === null) {
        result.title = {
          text: bounded.slice(tagEnd + 1, textEnd),
          position: positionOf(starts, open),
        }
      }
      if (close < 0) break
      const closeEnd = findTagEnd(bounded, close + 2)
      index = closeEnd < 0 ? bounded.length : closeEnd + 1
      continue
    }

    if (RAW_TEXT.includes(name)) {
      const close = findCloseTag(lowered, name, tagEnd + 1)
      if (close < 0) break
      const closeEnd = findTagEnd(bounded, close + 2)
      index = closeEnd < 0 ? bounded.length : closeEnd + 1
      continue
    }

    if (name === 'meta') {
      const metaName = (attributes.get('name') ?? '').trim().toLowerCase()
      if (metaName === 'description') {
        result.descriptionElements += 1
        if (result.description === null) {
          result.description = {
            text: attributes.has('content') ? attributes.get('content') : null,
            position: positionOf(starts, open),
          }
        }
      }
      const charset = charsetFromMeta(attributes)
      if (charset !== null && result.charset === null) {
        result.charset = { value: charset, position: positionOf(starts, open) }
      }
    }

    index = tagEnd + 1
  }

  // Reaching the end of a bounded prefix without ever seeing the head close is
  // the one case where "nothing was found" would be a lie.
  if (result.truncated === null && !result.headEnded && boundedByLength) {
    result.truncated = 'maxHeadLength'
  }
  return result
}
