# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Renaming a `ruleId` is a breaking change and will be recorded here.

## [Unreleased]

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

No release has been published.
