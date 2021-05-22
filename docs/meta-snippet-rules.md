# Rule catalog, counting semantics and limits

This document is the contract. `test/catalog.test.mjs` asserts the rule table below against
`RULE_SEVERITY` in `src/rules.mjs` in **both** directions, so a rule cannot be added, removed or
re-graded in the code without this file changing with it.

## How a snippet becomes a number

Every title and every description goes through the same five steps, in this order:

1. **Decode character references.** The five XML predefined entities plus a documented table of
   seventeen typographic ones (`nbsp`, `ndash`, `mdash`, `hellip`, `lsquo`, `rsquo`, `ldquo`,
   `rdquo`, `copy`, `reg`, `trade`, `middot`, `bull`, `laquo`, `raquo`, `times`, `deg`), and any
   numeric reference. A named reference outside that table is left exactly as written and reported
   with `entity-not-decoded`, so the resulting count is known to be approximate rather than
   silently wrong.
2. **Collapse whitespace.** Runs of the five ASCII space characters (tab, line feed, form feed,
   carriage return, space) become one space, and the result is trimmed — the way a browser lays a
   title out. A no-break space is a character the author chose, and it is kept and counted.
3. **Normalise to NFC.** See below.
4. **Bound the length.** A snippet longer than `maxTextLength` UTF-16 code units is reported with
   `text-truncated` and is then neither measured nor compared against anything.
5. **Count** in the configured unit.

### Why NFC, and what that means for you

The same visible text can be encoded in more than one way. `é` is either U+00E9 or the two code
points `e` + U+0301; both paint one glyph. Counting the source form would give one visible title
two different lengths depending on which build step emitted it, and would let two identical-looking
titles slip past duplicate grouping.

So the NFC form is what is counted and what is grouped. A page whose source was not already NFC is
told so with `text-not-nfc` — an `info` finding, because nothing is wrong with the page, but the
number in the report is the normalised one and you should know that.

### The three counting units

`counting` is required and has no default, because the same build passes under one unit and fails
under another.

| Unit | What it counts | Example: `⚠️` (U+26A0 U+FE0F) | Example: `👩‍👩‍👧` |
| --- | --- | ---: | ---: |
| `graphemes` | user-perceived characters, via `Intl.Segmenter` | 1 | 1 |
| `codePoints` | Unicode scalar values | 2 | 5 |
| `utf16CodeUnits` | `String.prototype.length` | 2 | 8 |

`graphemes` is the unit closest to what a reader sees and is the one to choose unless a downstream
system forces another. It depends on the ICU data compiled into the running Node build: a future
Node with newer ICU could segment a newly standardised emoji sequence differently. `codePoints` and
`utf16CodeUnits` are properties of the string alone and never move. A Node build without
`Intl.Segmenter` (small-icu) refuses a `graphemes` configuration rather than quietly counting
something else.

## Duplicate grouping

`duplicateScope` is required and has no default, because it decides the answer.

- `locale` — two pages are duplicates only if they share a snippet **and** a locale. This is the
  right choice for a site whose locales are separate indexes.
- `site` — two pages are duplicates if they share a snippet at all, whatever their locales.

Grouping is on the normalised text, so `Café` and `Cafe` + combining acute group together. A page
whose snippet was missing, empty, truncated, or whose locale is outside the configured scope, joins
no group at all: a snippet that was not fully read must not create or suppress a duplicate.

## Locale scope and coverage

`locales` declares the scope. A page whose `locale` is not a declared key produces
`locale-not-declared`, is not measured and is not grouped — it is counted in `summary.skipped`, not
in `summary.checked`. Pages are never discovered by walking a directory; every page comes from the
configuration, which is what makes the run reproducible and makes a page that was declared but
never built an observable gap (`page-unreadable`) rather than an absence nobody notices.

## The rule catalog

| Rule | Severity | What it means |
| --- | --- | --- |
| `charset-not-utf8` | warning | The document declares an encoding other than UTF-8. It was decoded as UTF-8 anyway, so the counts describe that reading. Marks the run incomplete. |
| `description-duplicate` | error | This description is shared with another page in the configured duplicate scope. |
| `description-empty` | error | A meta description element exists but carries no usable text. |
| `description-missing` | error | No meta description element was found in the head. |
| `description-repeated-element` | warning | More than one meta description in the head. The first was used, as a browser would. |
| `description-too-long` | error | Above the maximum configured for this locale. |
| `description-too-short` | error | Below the minimum configured for this locale. |
| `entity-not-decoded` | info | The snippet contains a named character reference outside the decoding table, so its counted length includes the reference as written. |
| `head-scan-truncated` | warning | `maxHeadLength` or `maxTags` stopped the scan before the head ended. Marks the run incomplete. |
| `html-lang-mismatch` | warning | The configured locale and the document's `lang` attribute disagree. |
| `html-lang-missing` | info | The html element has no `lang`, so the configured locale could not be confirmed against the document. |
| `locale-not-declared` | error | The page's locale is outside the configured locale scope, so no policy was applied to it. |
| `nothing-checked` | error | No page was measured at all. A report over no evidence is not a pass. |
| `page-limit-exceeded` | error | More pages were declared than `maxPages` allows. Nothing was read. Marks the run incomplete. |
| `page-not-utf8` | error | The file's bytes are not valid UTF-8, so nothing was decoded from it. Marks the run incomplete. |
| `page-too-large` | error | The file is larger than `maxHtmlBytes`. It was not read. Marks the run incomplete. |
| `page-unreadable` | error | A declared page could not be opened, or is not a regular file. Marks the run incomplete. |
| `text-not-nfc` | info | The snippet was not in NFC form. It was normalised before counting and grouping. |
| `text-truncated` | warning | The snippet is longer than `maxTextLength`, so it was neither measured nor compared. Marks the run incomplete. |
| `title-duplicate` | error | This title is shared with another page in the configured duplicate scope. |
| `title-empty` | error | A title element exists but is empty once whitespace is collapsed. |
| `title-missing` | error | No title element was found in the head. |
| `title-repeated-element` | warning | More than one title in the head. The first was used, as a browser would. |
| `title-too-long` | error | Above the maximum configured for this locale. |
| `title-too-short` | error | Below the minimum configured for this locale. |

### Why a length rule is an error

Because you declared the bound. The numbers themselves are house style — no search engine publishes
a character limit, snippets are truncated by rendered width in a layout nobody controls, and an
engine may rewrite a snippet entirely. That honesty belongs in the wording, and the report carries
it in every length message and in `notes[0]`. But a linter that only ever warns about the policy it
was handed does not enforce that policy, and a bound that cannot fail a build is a bound nobody
reads. If a bound should not fail your build, widen it — do not rely on the severity to be inert.

## Status and exit codes

`incomplete` outranks `fail`, which outranks `pass`. "We could not look" and "we looked and it is
wrong" are different answers, and neither is "fine".

| Status | Exit | When |
| --- | ---: | --- |
| `pass` | 0 | Every declared page was measured and no error-severity rule fired. |
| `fail` | 1 | Every declared page was measured and at least one error fired. |
| `incomplete` | 2 | Evidence was missing, undecodable or bounded out (the rules marked above). |

A configuration error is also exit 2, but has a different shape: stdout stays **empty** and the
message goes to stderr, because a run that never had a subject has nothing to report about. An
unreadable *input* always produces a report, because a consumer needs to know which page was not
read.

## Limits

Every limit is enforceable from `limits` in the config and from a command-line flag, and every one
is covered by a test that fails if the wiring is removed.

| Limit | Flag | Default | Exceeding it |
| --- | --- | ---: | --- |
| `maxPages` | `--max-pages` | 5000 | `page-limit-exceeded`, nothing is read |
| `maxHtmlBytes` | `--max-html-bytes` | 2000000 | `page-too-large` for that page |
| `maxHeadLength` | `--max-head-length` | 262144 | `head-scan-truncated` for that page |
| `maxTags` | `--max-tags` | 5000 | `head-scan-truncated` for that page |
| `maxTextLength` | `--max-text-length` | 4096 | `text-truncated` for that snippet |

An unknown key anywhere in the configuration — a top-level key, a page key, a locale override key,
a bound key, a limit name — is a configuration error. A key that is accepted and then never read is
how a one-character typo turns a real failure into a green run. A limit value that is not a positive
integer is refused the same way, from the config and from a command-line flag alike.

`schemaVersion` must be exactly the string `"1"`. A document written for any other schema version,
or for none, is refused rather than read on the assumption that the parts this version understands
still mean what they used to.

A locale override merges over `defaults` and is then checked as a whole: an override whose merged
`min` exceeds its merged `max` is a configuration error, because a bound no snippet can satisfy
would otherwise be reported as a failure of the site rather than of the configuration.

## The report, and what this tool adds to the envelope

The report follows the Edilec report contract v1. Two additions are tool-specific and documented
here so a consumer knows they are deliberate:

- `summary` carries `info`, `pages`, `skipped` and `duplicateGroups` alongside the contract's
  `checked`, `errors` and `warnings`. `pages` is what the configuration declared; `checked` is what
  was actually measured; `skipped` is the difference.
- `location` carries 1-based `line` and `column` for a finding about an element the scanner found,
  alongside the contract's `file` and `pointer`. `pointer` is a documented field path rather than a
  JSON Pointer into the input: `/document`, `/html[lang]`, `/head/title`, `/head/meta[charset]` or
  `/head/meta[name=description]`.
- `notes` is an array of two sentences carried in every report: the heuristic disclaimer and the
  counting-pipeline statement. They are in the report rather than only in this document so a
  number lifted out of the JSON cannot be quoted without them.

`evidence` is a single-line excerpt of at most 160 characters of page text, followed by a literal
`...` when the value was longer than that. Every C0 control character, `DEL`, every C1 control
character and the two Unicode line separators (U+2028, U+2029) are replaced with a space, and
whitespace runs are then collapsed and trimmed. The scrub itself is bounded: at most the first 8192
code units of a value are ever scanned, however long the value is.

Page content is data: it is never echoed at length, and never in a shape that could read as an
instruction to whoever reads the report — or as a control sequence to the terminal the stderr
summary is rendered in.

## Determinism

Findings are ordered by `location.file`, then `location.pointer`, then `ruleId`, then
`location.line`, then `location.column`, then `message`. A finding with no file or pointer sorts as
the empty string, so configuration-level findings come first.

All ordering uses UTF-16 code-unit comparison. `localeCompare` is never used anywhere in this tool:
it depends on ICU data that varies between Node builds, and has already produced a real ordering
difference elsewhere in this catalogue.

## Path confinement

Page paths are relative to the input root (the config's directory, or `--root`). A path is refused
if it is absolute, if it resolves outside the root by spelling, **or** if its real path — after
every symbolic link on it has been followed — falls outside the real path of the root. Refusal
happens before the file is opened, so no out-of-root content ever reaches the report.

Only regular files are read. A directory, a named pipe or a device node standing where a page
should be is `page-unreadable` with the reason `not a regular file`, and is never opened: opening a
pipe would make the linter wait on whatever writes to it, and reading one would measure a stream
rather than the page the build shipped.
