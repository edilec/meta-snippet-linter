# Meta Snippet Linter

Read the titles and meta descriptions a build actually shipped, count them in one explicitly chosen
unit, and hold them against one explicit policy: per-locale length bounds, uniqueness within a
declared scope, and coverage of every page the configuration says exists — each finding carrying the
file, the element and the line it came from.

- **Repository:** [edilec/meta-snippet-linter](https://github.com/edilec/meta-snippet-linter)
- **Area:** SEO & Search
- **License:** MIT
- **Dependencies:** none. Node 22+ built-ins only.

```
npx meta-snippet-linter --config site/meta.config.json
```

## What it does

```
$ meta-snippet-linter --config examples/broken/meta.config.json
meta-snippet-linter: fail
  4 of 5 page(s) measured, 1 skipped, 2 duplicate group(s)
  9 error(s), 2 warning(s), 0 info
  [error] title-duplicate build/copy.html:5:5 /head/title
      Page "/copy" shares its title with 1 other page(s) in locale "en": /.
  ...
  note: Length bounds are house-style heuristics, not search-engine guarantees: ...
```

stdout carries the JSON report and nothing else, so it pipes straight into a parser. The summary
above is on stderr, and `--json` silences it.

## Configuration

```json
{
  "schemaVersion": "1",
  "counting": "graphemes",
  "duplicateScope": "locale",
  "defaults": {
    "title": { "min": 20, "max": 60 },
    "description": { "min": 70, "max": 155 }
  },
  "locales": {
    "en": {},
    "ja": { "title": { "min": 8, "max": 32 }, "description": { "min": 30, "max": 90 } }
  },
  "pages": [
    { "path": "/", "file": "build/index.html", "locale": "en" },
    { "path": "/ja/", "file": "build/ja-index.html", "locale": "ja" }
  ]
}
```

`counting` and `duplicateScope` are required and have no default: both change the answer, and a
report that guessed either would not be saying what it measured. A locale entry inherits `defaults`
and overrides only the bounds it names. Unknown keys anywhere are refused, not ignored.

Runnable examples live in `examples/clean` (passes, exit 0) and `examples/broken` (fails, exit 1).

## Counting, exactly

Counting is the subtle part, so the choice is explicit and documented rather than assumed. Every
snippet is decoded, whitespace-collapsed and **NFC-normalised** before it is counted and before it
is grouped, so two titles that render identically always count identically — and `text-not-nfc`
tells you when a page's source needed normalising.

| Unit | `⚠️` (U+26A0 U+FE0F) | `👩‍👩‍👧` | `Café` (decomposed) |
| --- | ---: | ---: | ---: |
| `graphemes` | 1 | 1 | 4 |
| `codePoints` | 2 | 5 | 4 |
| `utf16CodeUnits` | 2 | 8 | 4 |

`graphemes` uses the built-in `Intl.Segmenter`. Full details, including what NFC normalisation does
to your numbers, are in [docs/meta-snippet-rules.md](./docs/meta-snippet-rules.md).

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every declared page was measured and the policy was satisfied |
| `1` | the build failed the policy |
| `2` | a configuration error (stdout empty), or evidence missing, undecodable or bounded out (an `incomplete` report on stdout) |

`incomplete` outranks `fail`, which outranks `pass`. A run that could not read a page never exits 0,
and a run that measured nothing reports `nothing-checked` rather than coming back clean.

## Limits and non-goals

**The length bounds are house style, not search-engine guarantees.** No engine publishes a character
limit. Snippets are truncated by rendered pixel width in a layout nobody controls, on a device
nobody controls, and an engine may rewrite a title or description entirely from page content. A
title inside your bounds is a title that matches the policy you wrote down — nothing more. This tool
carries that sentence in its own report so it cannot be quoted as a ranking promise.

Things this tool **cannot** conclude:

- **Whether a snippet is good.** It measures length, uniqueness and presence. Relevance, accuracy,
  tone and keyword intent are outside what a file can tell it.
- **What a search engine will display, index or rank.** It never contacts one, and nothing in its
  output is evidence about one.
- **What a client-rendered page ends up showing.** It reads the shipped HTML. A title written by
  JavaScript after load, injected by a framework at runtime, or swapped by a client-side router is
  invisible to it.
- **That an unlisted page is fine.** Pages come only from the configuration; nothing is discovered
  by walking a directory. That is what makes runs reproducible, and it means coverage is exactly as
  complete as your page list.
- **That a page it could not read is fine.** An unreadable, oversized, non-UTF-8 or bounded-out page
  is `incomplete` and exit 2, never a pass. Only regular files are read: a directory or a named pipe
  standing where a page should be is refused rather than opened.
- **Anything about `og:description`, `twitter:description` or a `<base>`-relative rewrite.** Only
  `<title>` and `<meta name="description">` are read.
- **That the head is exactly what a browser would build.** The scanner reads forward through markup
  rather than constructing a DOM: it understands comments, doctypes, raw-text elements and quoted
  attributes, but it does not run scripts or repair broken nesting.
- **That an encoding other than UTF-8 was read correctly.** UTF-8 is the only encoding supported;
  anything else is decoded strictly, and a failure is reported rather than patched with replacement
  characters.

It reads files and nothing else: no network, no telemetry, no writes. A page path that leaves the
input root — by spelling, or through a symbolic link planted inside it — is refused before the file
is opened. Page text that does reach the report is quoted as a bounded, single-line excerpt with
control characters replaced, so nothing a build directory contains can repaint the terminal the
summary is printed in.

A config file that does not parse is reported by position, line and column, never by quoting it
back: `JSON.parse` embeds the input in one of its two error messages, so a config short enough to
be only a credential would otherwise be reproduced in full by its own failure.

## Development

```
npm run check     # lint, test, run the clean example, and dry-run the package
npm test
npm run test:coverage
```

No dependencies, no install step. `docs/meta-snippet-rules.md` is the rule contract and the test
suite asserts the code against it in both directions.

## License

MIT. See [LICENSE](./LICENSE).
