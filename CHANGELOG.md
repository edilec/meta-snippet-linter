# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Renaming a `ruleId` is a breaking change and will be recorded here.

## [Unreleased]

### Fixed

- A config file that does not parse is no longer echoed back on stderr.
  `JSON.parse` embeds the input in one of its two error messages
  (`Unexpected token 'A', "AKIA…" is not valid JSON`), so a config short enough
  to be only a credential was reproduced in full by `The config is not valid
  JSON: …`. `parseFailureDetail` in `src/rules.mjs` keeps the position, line
  and column — which carry no input — and drops the quotation. Excerpting the
  message would not have helped: the quotation is at the front of the message
  and `excerpt` cuts from the back.

### Added

- Bounded head scanner for built HTML that reads `<title>`, `<meta name="description">`, the html
  `lang` attribute and a declared charset, with the source line and column of each.
- Explicit counting pipeline: character-reference decoding, ASCII whitespace collapsing, NFC
  normalisation, length bounding, then counting in `graphemes`, `codePoints` or `utf16CodeUnits`.
  `counting` is required and has no default.
- Per-locale length policy with `defaults` and locale overrides that merge rather than replace.
- Duplicate grouping within a required `duplicateScope` of `locale` or `site`.
- Locale scope and coverage rules: a page outside the declared locales is reported and excluded, and
  a declared page that was never built is `page-unreadable` and `incomplete`.
- Report contract v1 output on stdout with a human summary on stderr, a frozen `ruleId` to severity
  table, and deterministic ordering by file, pointer, rule, line, column and message.
- `bin/meta-snippet-linter.mjs` with `--help`, `--json`, `--root`, `--counting`,
  `--duplicate-scope` and a flag for every documented limit.
- `examples/clean` and `examples/broken`, and the rule contract in `docs/meta-snippet-rules.md`.

### Security

- Page paths are confined to the input root by real path, after symbolic links are resolved, so a
  link planted inside the build output cannot cause an out-of-root file to be read or quoted.
- Only regular files are read. A directory, a named pipe or a device node standing where a page
  should be is `page-unreadable` with the reason `not a regular file`, and is never opened.
- Report evidence is scrubbed of every C0, `DEL` and C1 control character and of the two Unicode
  line separators, bounded to 160 characters out and 8192 code units in, so page content cannot
  repaint the terminal the stderr summary is rendered in.

No release has been published.
