#!/usr/bin/env node

/**
 * The command line surface.
 *
 * stdout carries the JSON report and nothing else, so it can be piped straight
 * into a parser. The human-readable summary goes to stderr, and is suppressed
 * by `--json` for callers that want a quiet machine run.
 *
 * Exit 2 has two shapes, and they are deliberately different:
 *
 * - a configuration error means the run never had a subject, so stdout stays
 *   empty and the message goes to stderr;
 * - an input that could not be read means the run had a subject and failed to
 *   get evidence about it, so a report with status "incomplete" is written and
 *   names the page.
 */

import { ConfigError, formatReport, exitCodeFor, lintMetaSnippets, serializeReport } from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `meta-snippet-linter ${VERSION}

Lint the titles and meta descriptions of built HTML against one explicit
policy: per-locale length bounds, uniqueness within a declared scope, and
coverage of every page the configuration declares. Nothing is ever fetched.

Usage:
  meta-snippet-linter --config FILE [--root DIR] [--json] [overrides]

Options:
  --config FILE          Policy and page list to read (required)
  --root DIR             Input root for page paths (default: the config's directory)
  --json                 Report only; suppress the human summary on stderr
  --counting UNIT        graphemes | codePoints | utf16CodeUnits
  --duplicate-scope S    locale | site
  --max-pages N          Maximum declared pages (default 5000)
  --max-html-bytes N     Maximum bytes per built page (default 2000000)
  --max-head-length N    Maximum UTF-16 code units scanned for the head (default 262144)
  --max-tags N           Maximum tags scanned per page (default 5000)
  --max-text-length N    Maximum UTF-16 code units per snippet (default 4096)
  --version              Print the version
  -h, --help             Show this help

Length bounds are house-style heuristics, not search-engine guarantees: no
engine publishes a character limit, snippets are truncated by rendered width
rather than character count, and an engine may rewrite a snippet entirely.

A page path that leaves the input root -- by spelling or through a symbolic
link -- is refused and never read.

Exit codes:
  0  every declared page was measured and the policy was satisfied
  1  the build failed the policy
  2  invalid configuration (empty stdout), or evidence that was missing,
     undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-pages', 'maxPages'],
  ['--max-html-bytes', 'maxHtmlBytes'],
  ['--max-head-length', 'maxHeadLength'],
  ['--max-tags', 'maxTags'],
  ['--max-text-length', 'maxTextLength'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('--version')) return { version: true }
  const options = { config: null, root: null, json: false, counting: undefined, duplicateScope: undefined, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--counting') options.counting = takeValue('--counting')
    else if (argument === '--duplicate-scope') options.duplicateScope = takeValue('--duplicate-scope')
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await lintMetaSnippets({
      config: options.config,
      root: options.root ?? undefined,
      counting: options.counting,
      duplicateScope: options.duplicateScope,
      limits: options.limits,
    })
  } catch (error) {
    // A configuration error produced no subject, so it produces no report.
    const prefix = error instanceof ConfigError ? 'Config error' : 'Execution failure'
    process.stderr.write(`${prefix}: ${error.message}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
