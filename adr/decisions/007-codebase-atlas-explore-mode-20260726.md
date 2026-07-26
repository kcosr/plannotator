# 007. Codebase Atlas as a standalone explore mode

Date: 2026-07-26

## Status

Accepted

## Context

Plannotator already provides the application shell needed for local repository
exploration: an on-demand CLI process, loopback/remote port handling, browser or
Glimpse launch, session discovery, shared UI primitives, Pierre code rendering,
token interaction, code navigation, VCS awareness, and safe local file access.

The code-review application is not the right ownership boundary for a
whole-repository explorer. Its state and server already coordinate multiple VCS
providers, diff snapshots, annotations, agent jobs, PR worktrees, and review
submission. Adding repository indexing and several persistent visualization
modes directly to that surface would couple unrelated lifecycles and make the
largest modules harder to maintain.

## Decision

Add **Codebase Atlas** as a standalone Plannotator mode launched with:

```bash
plannotator explore [path]
```

1. **One indexed model, several linked views.** Overview, Symbols, and Source
   consume the same repository snapshot and preserve the selected directory,
   file, or symbol while switching views. Dependency analysis is an Overview
   mode because it projects relationships onto the same treemap.

2. **Blocks are the primary visual grammar.** Repository structure is rendered
   as a zoomable nested treemap. Dependency mode projects incoming and outgoing
   relationships onto those blocks instead of introducing a force-directed
   node graph.

3. **Indexing is asynchronous.** The server binds and opens the UI before the
   repository scan completes. The client observes indexing status and can
   explicitly refresh the snapshot.

4. **The server is session-scoped.** Explore reuses Plannotator's port,
   browser/Glimpse, remote-session, and session-registry infrastructure. It
   remains alive until the UI closes the session or the CLI process receives a
   termination signal.

5. **Source is read-only.** Pierre's file renderer provides syntax highlighting,
   line selection, and token events without adding an editor. Definition and
   reference results come from the Atlas index rather than from the renderer.

6. **The index has one normalized contract.** Filesystem hierarchy, metrics,
   symbols, and dependencies are emitted in a language-independent shape.
   Language analyzers enrich that model; the UI never consumes raw ASTs.

7. **Review integration reuses Atlas components later.** A review-scoped map may
   overlay changed files on the same model, but the standalone explore server
   and Atlas package remain the owners of repository indexing and visualization.
   Review does not gain a second copy of those implementations.

## Consequences

- Explore adds a separate single-file frontend artifact and server entry point
  to the existing binary build.
- Repository scanning must enforce path containment, ignore generated/vendor
  content, bound file size and count, and avoid reading binary files as text.
- The initial language analysis can be structural and confidence-aware. Precise
  compiler or SCIP adapters can replace individual analyzers without changing
  the client contract.
- The existing search-based code-navigation backend remains available to code
  review, while Explore owns repository-wide symbol and dependency data.
- New shared functionality belongs in bounded Atlas packages rather than
  expanding `review-editor/App.tsx` or `server/review.ts`.
