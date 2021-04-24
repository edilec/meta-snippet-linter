/**
 * meta-snippet-linter
 *
 * Read the titles and descriptions a build actually shipped, count them in one
 * explicitly chosen unit, and hold them against one explicit policy: length
 * bounds per locale, uniqueness within a declared scope, and coverage of every
 * page the configuration says exists.
 *
 * Two things this tool refuses to do, because doing them would make its output
 * mean less than it appears to:
 *
 * - It never fetches anything. Every page it reports on is a file it read.
 * - It never presents a length bound as a search-engine guarantee. No engine
 *   publishes a character limit; snippets are truncated by rendered pixel width
 *   in a layout nobody controls, and are frequently rewritten wholesale. The
 *   bounds here are house style, and the report says so in its own text.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  COUNT_UNITS,
  countUnits,
  graphemeSupport,
  normalizeSnippet,
} from './count.mjs'
import { scanHead } from './html.mjs'
import { at, byCodeUnit, compareFindings, excerpt, makeFinding } from './rules.mjs'

export { COUNT_UNITS, countUnits, decodeEntities, normalizeSnippet, NAMED_ENTITIES } from './count.mjs'
export { scanHead } from './html.mjs'
export { RULE_IDS, RULE_SEVERITY, SEVERITIES, byCodeUnit, compareFindings, severityOf } from './rules.mjs'

export const TOOL_ID = 'meta-snippet-linter'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

export const DUPLICATE_SCOPES = Object.freeze(['locale', 'site'])

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A build directory is untrusted input. Every limit below is explicit,
 * overridable from the configuration and from the command line, and reported
 * when it is hit: exceeding one produces a finding and an `incomplete` report,
 * never a quietly shorter answer.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxPages: 5000,
  maxHtmlBytes: 2000000,
  maxHeadLength: 262144,
  maxTags: 5000,
  maxTextLength: 4096,
})

const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))
const CONFIG_KEYS = Object.freeze([
  'schemaVersion',
  'counting',
  'duplicateScope',
  'defaults',
  'locales',
  'pages',
  'limits',
])
const PAGE_KEYS = Object.freeze(['path', 'file', 'locale'])
const FIELD_KEYS = Object.freeze(['title', 'description'])
const BOUND_KEYS = Object.freeze(['min', 'max'])
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8}){0,3}$/
const MAX_LISTED_DUPLICATES = 5

/**
 * The disclaimer that travels with the report.
 *
 * The acceptance criterion for this tool is that its length rules are not
 * described as search-engine guarantees. Saying it once in the README would be
 * easy to lose; it is carried in the report itself, where the numbers are.
 */
export const HEURISTIC_NOTE =
  'Length bounds are house-style heuristics, not search-engine guarantees: no engine publishes a character limit, snippets are truncated by rendered width rather than character count, and an engine may rewrite a snippet entirely.'

export const COUNTING_NOTE =
  'Snippets are decoded, whitespace-collapsed and NFC-normalised before they are counted and before they are grouped, so two snippets that render identically count identically.'

/** A problem with the configuration itself, not with the site being checked. */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapes(from, target) {
  const rel = relative(from, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The real path a target would have once every symbolic link on the way to it
 * is followed.
 *
 * `realpath` needs the whole path to exist, but a page that was never built
 * must still reach the audit as a `page-unreadable` finding rather than a
 * configuration error. So the deepest ancestor that does exist is resolved for
 * real and the missing segments below it are appended literally: a link
 * anywhere along the existing part is still followed, and a missing leaf keeps
 * the location its parent gives it.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new ConfigError(
          `${describe} could not be resolved (${error.code ?? 'unknown error'})`,
          'input-unresolvable',
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a declared input path, refusing to leave the declared root.
 *
 * The configuration is data, and data does not choose which files this tool
 * opens. Spelling a path is not the only way to leave a tree, so the lexical
 * check is not the boundary: a symbolic link planted inside the build output
 * points wherever it likes, and following one would read a file the
 * configuration never had the right to name and echo its content into the
 * report as "evidence". The resolved path is therefore confined again after
 * every link on it has been followed, against the real path of the root itself
 * (the root may sit behind a link too, as `/var` does on macOS).
 */
async function resolveWithin(root, realRoot, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty relative path`, 'input-not-relative')
  }
  if (isAbsolute(candidate)) {
    throw new ConfigError(
      `${label} must be relative to the input root, but "${excerpt(candidate)}" is absolute`,
      'input-not-relative',
    )
  }
  const resolved = resolve(root, candidate)
  if (escapes(root, resolved)) {
    throw new ConfigError(`${label} resolves outside the input root: "${excerpt(candidate)}"`, 'input-outside-root')
  }
  const real = await realPathOf(resolved, `${label} ("${excerpt(candidate)}")`)
  if (escapes(realRoot, real)) {
    throw new ConfigError(
      `${label} leaves the input root through a symbolic link: "${excerpt(candidate)}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return resolved
}

function assertBounds(value, label) {
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object with min and max`)
  for (const key of Object.keys(value)) {
    if (!BOUND_KEYS.includes(key)) {
      throw new ConfigError(`Unknown key "${key}" in ${label}. Known keys: ${BOUND_KEYS.join(', ')}`)
    }
  }
  for (const key of BOUND_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new ConfigError(`${label}.${key} must be a non-negative integer`)
    }
  }
  if (value.min > value.max) throw new ConfigError(`${label}.min must not exceed ${label}.max`)
  return { min: value.min, max: value.max }
}

function assertPartialBounds(value, label, base) {
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!BOUND_KEYS.includes(key)) {
      throw new ConfigError(`Unknown key "${key}" in ${label}. Known keys: ${BOUND_KEYS.join(', ')}`)
    }
  }
  const merged = { ...base }
  for (const key of BOUND_KEYS) {
    if (value[key] === undefined) continue
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new ConfigError(`${label}.${key} must be a non-negative integer`)
    }
    merged[key] = value[key]
  }
  if (merged.min > merged.max) throw new ConfigError(`${label}.min must not exceed ${label}.max`)
  return merged
}

function assertPolicy(value, label, base) {
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!FIELD_KEYS.includes(key)) {
      throw new ConfigError(`Unknown key "${key}" in ${label}. Known keys: ${FIELD_KEYS.join(', ')}`)
    }
  }
  return {
    title: value.title === undefined ? base.title : assertPartialBounds(value.title, `${label}.title`, base.title),
    description:
      value.description === undefined
        ? base.description
        : assertPartialBounds(value.description, `${label}.description`, base.description),
  }
}

/**
 * Validate the configuration document.
 *
 * `counting` and `duplicateScope` are required and have no default. Both change
 * the answer: the same build passes under one counting unit and fails under
 * another, and the same two pages are duplicates under a site-wide scope and
 * are not under a per-locale one. Guessing either would mean the report does
 * not say what it was actually measuring.
 *
 * Unknown keys are refused rather than ignored. A configuration key that is
 * accepted and then never read is how a typo turns a real failure into a green
 * run.
 */
export function validateConfig(document, overrides = {}) {
  if (!isRecord(document)) throw new ConfigError('Config must be a JSON object')
  for (const key of Object.keys(document)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new ConfigError(`Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(', ')}`)
    }
  }
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported config schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }

  const counting = overrides.counting ?? document.counting
  if (!COUNT_UNITS.includes(counting)) {
    throw new ConfigError(
      `counting must be one of ${COUNT_UNITS.join(', ')}, got "${String(counting ?? 'missing').slice(0, 40)}"`,
    )
  }
  if (counting === 'graphemes' && !graphemeSupport()) {
    throw new ConfigError(
      'counting "graphemes" needs Intl.Segmenter, which this Node build does not provide. Choose codePoints or utf16CodeUnits explicitly rather than letting the count change silently.',
    )
  }

  const duplicateScope = overrides.duplicateScope ?? document.duplicateScope
  if (!DUPLICATE_SCOPES.includes(duplicateScope)) {
    throw new ConfigError(
      `duplicateScope must be one of ${DUPLICATE_SCOPES.join(', ')}, got "${String(duplicateScope ?? 'missing').slice(0, 40)}"`,
    )
  }

  if (!isRecord(document.defaults)) throw new ConfigError('Config is missing its defaults object')
  for (const key of Object.keys(document.defaults)) {
    if (!FIELD_KEYS.includes(key)) {
      throw new ConfigError(`Unknown key "${key}" in defaults. Known keys: ${FIELD_KEYS.join(', ')}`)
    }
  }
  const defaults = {
    title: assertBounds(document.defaults.title, 'defaults.title'),
    description: assertBounds(document.defaults.description, 'defaults.description'),
  }

  if (!isRecord(document.locales)) throw new ConfigError('Config is missing its locales object')
  const localeTags = Object.keys(document.locales)
  if (localeTags.length === 0) throw new ConfigError('locales must declare at least one locale tag')
  const locales = new Map()
  for (const tag of localeTags) {
    if (!LOCALE_PATTERN.test(tag)) {
      throw new ConfigError(`"${tag.slice(0, 40)}" is not a usable locale tag such as en or pt-BR`)
    }
    locales.set(tag, assertPolicy(document.locales[tag], `locales.${tag}`, defaults))
  }

  if (!Array.isArray(document.pages) || document.pages.length === 0) {
    throw new ConfigError('Config must declare a non-empty pages array')
  }
  const seenPaths = new Set()
  const pages = document.pages.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`pages[${index}] must be an object`)
    for (const key of Object.keys(entry)) {
      if (!PAGE_KEYS.includes(key)) {
        throw new ConfigError(`Unknown key "${key}" in pages[${index}]. Known keys: ${PAGE_KEYS.join(', ')}`)
      }
    }
    if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
      throw new ConfigError(`pages[${index}].path must be a site-relative path beginning with "/"`)
    }
    if (seenPaths.has(entry.path)) {
      throw new ConfigError(`pages[${index}].path "${excerpt(entry.path)}" is declared more than once`)
    }
    seenPaths.add(entry.path)
    if (typeof entry.file !== 'string' || entry.file.trim() === '') {
      throw new ConfigError(`pages[${index}].file must name the built document for this page`)
    }
    if (typeof entry.locale !== 'string' || entry.locale.trim() === '') {
      throw new ConfigError(`pages[${index}].locale must be a locale tag`)
    }
    return { index, path: entry.path, file: toPosix(entry.file), locale: entry.locale.trim() }
  })

  const limits = {}
  const declaredLimits = document.limits ?? {}
  if (!isRecord(declaredLimits)) throw new ConfigError('limits must be an object')
  for (const [name, value] of Object.entries(declaredLimits)) {
    if (!LIMIT_NAMES.includes(name)) {
      throw new ConfigError(`Unknown limit "${name}". Known limits: ${LIMIT_NAMES.join(', ')}`)
    }
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`limits.${name} must be a positive integer`)
    limits[name] = value
  }
  for (const [name, value] of Object.entries(overrides.limits ?? {})) {
    if (!LIMIT_NAMES.includes(name)) {
      throw new ConfigError(`Unknown limit "${name}". Known limits: ${LIMIT_NAMES.join(', ')}`)
    }
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`limits.${name} must be a positive integer`)
    limits[name] = value
  }

  return { schemaVersion: CONFIG_SCHEMA_VERSION, counting, duplicateScope, defaults, locales, pages, limits }
}

/**
 * Read one page, refusing anything the limits do not allow.
 *
 * Decoding is strict on purpose. `TextDecoder` in fatal mode reports bytes that
 * are not UTF-8 as a failure rather than substituting U+FFFD, so a file the
 * tool could not actually read can never be mistaken for a file whose title
 * happens to contain a replacement character.
 */
async function readPage(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { state: 'unreadable', reason: error.code ?? 'unknown error', source: null, bytes: 0 }
  }
  if (!info.isFile()) return { state: 'unreadable', reason: 'not a regular file', source: null, bytes: 0 }
  if (info.size > maxBytes) return { state: 'too-large', reason: `${info.size} bytes`, source: null, bytes: info.size }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { state: 'unreadable', reason: error.code ?? 'unknown error', source: null, bytes: info.size }
  }
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { state: 'ok', reason: null, source, bytes: bytes.byteLength }
  } catch {
    return { state: 'not-utf8', reason: 'the bytes are not valid UTF-8', source: null, bytes: bytes.byteLength }
  }
}

/**
 * Read every input the configuration names.
 *
 * Reading is separated from auditing so the audit stays a pure function of what
 * was on disk: the same bytes always produce the same report, and the rules can
 * be exercised without a filesystem.
 */
export async function loadProject(options = {}) {
  if (typeof options.config !== 'string' || options.config.trim() === '') {
    throw new ConfigError('A config file path is required')
  }
  const configFile = resolve(options.config)
  let text
  try {
    text = await readFile(configFile, 'utf8')
  } catch (error) {
    throw new ConfigError(`Could not read the config (${error.code ?? 'unknown error'})`)
  }
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The config is not valid JSON: ${error.message}`)
  }

  const config = validateConfig(document, options)
  const root = resolve(options.root ?? dirname(configFile))
  const realRoot = await realPathOf(root, 'The input root')
  const limits = { ...DEFAULT_LIMITS, ...config.limits }

  const loadFindings = []
  let incomplete = false
  let pages = config.pages

  if (pages.length > limits.maxPages) {
    loadFindings.push(
      makeFinding(
        'page-limit-exceeded',
        `The config declares ${pages.length} pages, above the configured maxPages limit of ${limits.maxPages}. No page was read.`,
        at(null, '/pages'),
        { suggestion: 'Raise limits.maxPages or split the configuration into smaller cohorts.' },
      ),
    )
    incomplete = true
    pages = []
  }

  const documents = new Map()
  for (const page of pages) {
    if (documents.has(page.file)) continue
    const file = await resolveWithin(root, realRoot, page.file, `pages[${page.index}].file`)
    documents.set(page.file, await readPage(file, limits.maxHtmlBytes))
  }

  return { config, limits, pages, documents, loadFindings, incomplete }
}

function fieldPointer(field) {
  return field === 'title' ? '/head/title' : '/head/meta[name=description]'
}

function lengthMessage(field, unit, actual, bound, direction) {
  const comparison = direction === 'short' ? `below the minimum of ${bound}` : `above the maximum of ${bound}`
  return `The ${field} is ${actual} ${unit} long, ${comparison} for this locale. This bound is a house-style heuristic, not a search-engine guarantee.`
}

/**
 * Compare a declared locale with what the document says about itself.
 *
 * Matching is on subtag boundaries and case-insensitive, so a page declared
 * `en-GB` is satisfied by `en`, `en-GB` or `en-gb`, but not by `english` and
 * not by `eng`.
 */
function langAgrees(declared, found) {
  const left = declared.toLowerCase()
  const right = found.toLowerCase()
  if (left === right) return true
  const shorter = left.length < right.length ? left : right
  const longer = left.length < right.length ? right : left
  return longer.startsWith(`${shorter}-`)
}

function describeGroup(paths, own) {
  const others = paths.filter((path) => path !== own).sort(byCodeUnit)
  const listed = others.slice(0, MAX_LISTED_DUPLICATES)
  const remainder = others.length - listed.length
  const tail = remainder > 0 ? ` and ${remainder} more` : ''
  return `${listed.join(', ')}${tail}`
}

/**
 * Apply every rule to what was read. Pure: no clock, no filesystem, no network.
 */
export function auditProject(project) {
  const { config, limits } = project
  // What the configuration declared, not what survived the limits: a run that
  // refused to read 4000 pages must still say 4000 were asked for.
  const declaredPages = config.pages.length
  const findings = [...project.loadFindings]
  let incomplete = project.incomplete
  let checked = 0
  let skipped = 0

  const titleGroups = new Map()
  const descriptionGroups = new Map()

  const fail = (ruleId, message, location, extra) => {
    findings.push(makeFinding(ruleId, message, location, extra))
  }

  for (const page of project.pages) {
    const document = project.documents.get(page.file)
    const where = (pointer, position) => at(page.file, pointer, position)
    const about = `Page "${page.path}"`

    if (document.state === 'unreadable') {
      fail('page-unreadable', `${about} could not be read (${document.reason}). Its snippet was not checked.`, where('/document'), {
        suggestion: 'Build the page before linting, or remove it from the pages list.',
      })
      incomplete = true
      skipped += 1
      continue
    }
    if (document.state === 'too-large') {
      fail(
        'page-too-large',
        `${about} is ${document.reason}, above the configured maxHtmlBytes limit of ${limits.maxHtmlBytes}. It was not read.`,
        where('/document'),
        { suggestion: 'Raise limits.maxHtmlBytes if pages this size are expected.' },
      )
      incomplete = true
      skipped += 1
      continue
    }
    if (document.state === 'not-utf8') {
      fail('page-not-utf8', `${about} is not valid UTF-8, so nothing was decoded from it.`, where('/document'), {
        suggestion: 'Re-emit the page as UTF-8. This tool reads UTF-8 only and will not guess an encoding.',
      })
      incomplete = true
      skipped += 1
      continue
    }

    const head = scanHead(document.source, limits)

    if (head.truncated !== null) {
      fail(
        'head-scan-truncated',
        `${about} hit the configured ${head.truncated} limit of ${limits[head.truncated]} before its head ended, so the snippet found may not be the whole story.`,
        where('/document'),
        { suggestion: `Raise limits.${head.truncated} or emit the metadata earlier in the head.` },
      )
      incomplete = true
    }

    if (head.charset !== null && head.charset.value.toLowerCase() !== 'utf-8' && head.charset.value.toLowerCase() !== 'utf8') {
      fail(
        'charset-not-utf8',
        `${about} declares charset "${excerpt(head.charset.value)}", but this tool decoded it as UTF-8. The counts below describe the UTF-8 reading, which may not be what a browser shows.`,
        where('/head/meta[charset]', head.charset.position),
        { evidence: head.charset.value, suggestion: 'Serve and declare UTF-8, the only encoding this tool supports.' },
      )
      incomplete = true
    }

    const policy = config.locales.get(page.locale)
    if (policy === undefined) {
      fail(
        'locale-not-declared',
        `${about} declares locale "${excerpt(page.locale)}", which is not in the configured locale scope. Its length and uniqueness policies were not applied.`,
        where('/document'),
        {
          evidence: page.locale,
          suggestion: `Add "${excerpt(page.locale)}" to locales, or correct the page's locale.`,
        },
      )
      skipped += 1
      continue
    }

    if (head.lang === null) {
      fail('html-lang-missing', `${about} has no lang attribute on its html element, so its locale could not be confirmed against the document.`, where('/html[lang]'), {
        suggestion: `Add lang="${excerpt(page.locale)}" to the html element.`,
      })
    } else if (!langAgrees(page.locale, head.lang.value)) {
      fail(
        'html-lang-mismatch',
        `${about} is declared as locale "${excerpt(page.locale)}" but the document says lang="${excerpt(head.lang.value)}".`,
        where('/html[lang]', head.lang.position),
        { evidence: head.lang.value, suggestion: 'Make the build and the configuration agree about this page.' },
      )
    }

    if (head.titleElements > 1) {
      fail(
        'title-repeated-element',
        `${about} has ${head.titleElements} title elements in its head. The first was used; a browser does the same and the rest are dead weight.`,
        where('/head/title', head.title?.position ?? null),
      )
    }
    if (head.descriptionElements > 1) {
      fail(
        'description-repeated-element',
        `${about} has ${head.descriptionElements} meta description elements in its head. The first was used.`,
        where('/head/meta[name=description]', head.description?.position ?? null),
      )
    }

    const assessed = { title: null, description: null }

    for (const field of FIELD_KEYS) {
      const found = field === 'title' ? head.title : head.description
      const pointer = fieldPointer(field)
      if (found === null) {
        fail(`${field}-missing`, `${about} has no ${field} in its head.`, where(pointer), {
          suggestion: `Emit a ${field} for every indexable page.`,
        })
        continue
      }
      if (found.text === null) {
        fail(`${field}-empty`, `${about} has a ${field} element with no content attribute.`, where(pointer, found.position))
        continue
      }
      const snippet = normalizeSnippet(found.text, { maxLength: limits.maxTextLength })
      if (snippet.text === '') {
        fail(`${field}-empty`, `${about} has an empty ${field}.`, where(pointer, found.position))
        continue
      }
      if (snippet.truncated) {
        fail(
          'text-truncated',
          `${about} has a ${field} of ${snippet.sourceLength} UTF-16 code units, above the configured maxTextLength limit of ${limits.maxTextLength}. It was neither measured nor compared.`,
          where(pointer, found.position),
          { suggestion: 'Raise limits.maxTextLength, or shorten a snippet that is this far out of range.' },
        )
        incomplete = true
        continue
      }
      if (snippet.changedByNormalization) {
        fail(
          'text-not-nfc',
          `${about} has a ${field} that is not in NFC form. It was normalised before counting and before duplicate grouping, so the reported length is the normalised one.`,
          where(pointer, found.position),
          { evidence: snippet.text },
        )
      }
      if (snippet.undecodedEntity) {
        fail(
          'entity-not-decoded',
          `${about} has a ${field} containing a character reference outside this tool's decoding table, so its counted length includes the reference as written.`,
          where(pointer, found.position),
          { evidence: snippet.text, suggestion: 'Emit the character itself, or a numeric character reference.' },
        )
      }

      const bounds = policy[field]
      const length = countUnits(snippet.text, config.counting)
      if (length < bounds.min) {
        fail(`${field}-too-short`, lengthMessage(field, config.counting, length, bounds.min, 'short'), where(pointer, found.position), {
          evidence: snippet.text,
        })
      } else if (length > bounds.max) {
        fail(`${field}-too-long`, lengthMessage(field, config.counting, length, bounds.max, 'long'), where(pointer, found.position), {
          evidence: snippet.text,
        })
      }

      assessed[field] = { text: snippet.text, position: found.position, length }
    }

    checked += 1

    // A locale tag can never contain a slash, so prefixing with one keeps
    // (locale, text) pairs from colliding under the locale scope.
    const scopeKey = config.duplicateScope === 'locale' ? `${page.locale}/` : ''
    for (const field of FIELD_KEYS) {
      const value = assessed[field]
      if (value === null) continue
      const groups = field === 'title' ? titleGroups : descriptionGroups
      const key = scopeKey + value.text
      const bucket = groups.get(key)
      if (bucket === undefined) groups.set(key, { text: value.text, locale: page.locale, members: [{ page, value }] })
      else bucket.members.push({ page, value })
    }
  }

  let duplicateGroups = 0
  for (const [field, groups] of [['title', titleGroups], ['description', descriptionGroups]]) {
    const keys = [...groups.keys()].sort(byCodeUnit)
    for (const key of keys) {
      const group = groups.get(key)
      if (group.members.length < 2) continue
      duplicateGroups += 1
      const paths = group.members.map((member) => member.page.path)
      const scope =
        config.duplicateScope === 'locale' ? `locale "${excerpt(group.locale)}"` : 'the whole site'
      for (const member of group.members) {
        fail(
          `${field}-duplicate`,
          `Page "${member.page.path}" shares its ${field} with ${group.members.length - 1} other page(s) in ${scope}: ${describeGroup(paths, member.page.path)}.`,
          at(member.page.file, fieldPointer(field), member.value.position),
          {
            evidence: group.text,
            suggestion: `Give each page in this scope its own ${field}, or widen duplicateScope deliberately.`,
          },
        )
      }
    }
  }

  /**
   * Green on no evidence is a defect, not a pass.
   *
   * Every page can be skipped for reasons that are individually warnings or
   * exclusions, and a run that measured nothing must not come back clean just
   * because nothing was left to complain about.
   */
  if (checked === 0) {
    fail(
      'nothing-checked',
      `No page was measured: ${declaredPages} page(s) were declared and ${skipped} were skipped. A report over no evidence is not a pass.`,
      at(null, '/pages'),
      { suggestion: 'Fix the skipped pages above, or narrow the configuration to pages that exist.' },
    )
  }

  findings.sort(compareFindings)

  const summary = {
    checked,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    pages: declaredPages,
    skipped,
    duplicateGroups,
  }

  // Precedence is deliberate: an incomplete run is never reported as a pass,
  // and never reported as a plain failure either, because "we could not look"
  // and "we looked and it is wrong" are different answers.
  const status = incomplete ? 'incomplete' : summary.errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary,
    notes: [HEURISTIC_NOTE, COUNTING_NOTE],
    findings,
  }
}

export async function lintMetaSnippets(options = {}) {
  return auditProject(await loadProject(options))
}

export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

/** A human-readable summary. It goes to stderr; stdout is the report. */
export function formatReport(report) {
  const lines = [`${report.tool}: ${report.status}`]
  lines.push(
    `  ${report.summary.checked} of ${report.summary.pages} page(s) measured, ${report.summary.skipped} skipped, ${report.summary.duplicateGroups} duplicate group(s)`,
  )
  lines.push(
    `  ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.info} info`,
  )
  for (const finding of report.findings) {
    const location = finding.location ?? {}
    const position = location.line === undefined ? '' : `:${location.line}:${location.column}`
    const place = `${location.file ?? '(config)'}${position}${location.pointer === undefined ? '' : ` ${location.pointer}`}`
    lines.push(`  [${finding.severity}] ${finding.ruleId} ${place}`)
    lines.push(`      ${finding.message}`)
  }
  for (const note of report.notes) lines.push(`  note: ${note}`)
  return `${lines.join('\n')}\n`
}
