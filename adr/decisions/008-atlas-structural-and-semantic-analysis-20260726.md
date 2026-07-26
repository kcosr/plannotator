# Atlas structural and semantic analysis

Date: 2026-07-26

## Decision

Codebase Atlas uses two deliberately separate analysis layers:

1. `ast-grep outline` 0.44 or newer is the required structural indexer. It
   supplies parsed declarations, members, exact ranges, visibility, and import
   syntax. Atlas does not retain the former regular-expression declaration or
   import extractor as a fallback.
2. Language Server Protocol clients provide on-demand definitions and
   references. A server is started only when a user requests semantic
   navigation for its language, then reused for the Atlas session.
3. Rust test classification combines ast-grep item ranges with `#[test]`,
   test-runner attributes, test-required `#[cfg(...)]` predicates, and Cargo
   `tests/` path conventions. Classification is stored as exact source ranges
   so mixed files can be filtered without changing source coordinates.

The snapshot contract is version 3 and records the structural analyzer version,
source, parsed languages, per-language LSP availability, and required test
metrics on every node and symbol. Reference responses identify whether their
result came from an LSP or from indexed syntax. When an LSP is unavailable,
Atlas may return indexed declarations, but it must not label text matches as
semantic references.

## Distribution

Normal Plannotator installers place the pinned ast-grep binary under:

```text
<plannotator-data>/vendor/ast-grep/0.45.0/
```

The archive digest is pinned per platform. Source and Pi/npm development installs
also depend on `@ast-grep/cli` at the same version. An explicit
`PLANNOTATOR_AST_GREP_PATH` overrides both.

Language servers are not bundled. Atlas probes validated executables on `PATH`
or explicit per-server environment overrides and reports the resulting
capabilities to the client.

## Caching

Atlas snapshots remain session-memory state. No persistent Atlas cache is added
by this decision. Language servers may use their own required project caches;
those are owned by the external tools, not by the Atlas snapshot contract.
In particular, Atlas enables clangd's background index; clangd may persist that
index in its standard `.cache/clangd/index` location near the compilation
database.

## Rationale

Tree-sitter through ast-grep gives the map a consistent, syntax-aware baseline
across the supported languages. LSP remains a semantic enrichment because
language servers differ in installation, startup cost, workspace configuration,
and project coverage. Keeping the layers explicit prevents a block map from
mixing exact syntax facts with best-effort textual guesses.

`ast-grep outline` is currently marked experimental upstream, so its JSON is
validated at the process boundary and translated into Atlas's own versioned
schema. A future SCIP or compiler adapter can replace or supplement the LSP
layer without changing the structural index contract.
