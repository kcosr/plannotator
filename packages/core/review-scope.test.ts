import { describe, expect, test } from "bun:test";
import {
  aggregateReviewScope,
  parseReviewScopeDiff,
  type ReviewScopeAtlasNode,
} from "./review-scope";

describe("parseReviewScopeDiff", () => {
  test("parses additions, deletions, context, and zero-count hunk sides", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -7,2 +6,0 @@",
      "-old seven",
      "-old eight",
      "",
    ].join("\n"));

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({
      newPath: "src/new.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      newChangedRanges: [{ startLine: 1, endLine: 3 }],
    });
    expect(diff.files[0]!.oldPath).toBeUndefined();
    expect(diff.files[0]!.hunks[0]).toMatchObject({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 3,
      oldChangedRanges: [],
    });
    expect(diff.files[1]).toMatchObject({
      oldPath: "src/old.ts",
      status: "deleted",
      additions: 0,
      deletions: 2,
      oldChangedRanges: [{ startLine: 7, endLine: 8 }],
    });
    expect(diff.files[1]!.newPath).toBeUndefined();
    expect(diff.files[1]!.hunks[0]).toMatchObject({
      oldStart: 7,
      oldCount: 2,
      newStart: 6,
      newCount: 0,
      newChangedRanges: [],
    });
    expect(diff.totals).toEqual({
      changedFiles: 2,
      additions: 3,
      deletions: 2,
      changedLines: 5,
    });
  });

  test("tracks only changed lines and merges adjacent ranges across hunks", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,4 +10,4 @@",
      " context",
      "-old",
      "+new",
      " context",
      " context",
      "@@ -14,2 +14,3 @@",
      "-gone",
      "+next",
      "+extra",
      " context",
      "",
    ].join("\n"));

    expect(diff.files[0]).toMatchObject({
      additions: 3,
      deletions: 2,
      oldChangedRanges: [
        { startLine: 11, endLine: 11 },
        { startLine: 14, endLine: 14 },
      ],
      newChangedRanges: [
        { startLine: 11, endLine: 11 },
        { startLine: 14, endLine: 15 },
      ],
    });
  });

  test("counts hunk content whose payload starts with diff marker characters", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "--- removed heading",
      "+++ added heading",
      "",
    ].join("\n"));

    expect(diff.files[0]).toMatchObject({
      additions: 1,
      deletions: 1,
      oldChangedRanges: [{ startLine: 1, endLine: 1 }],
      newChangedRanges: [{ startLine: 1, endLine: 1 }],
    });
  });

  test("parses header-only rename and copy changes", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/template.ts b/copy.ts",
      "similarity index 100%",
      "copy from template.ts",
      "copy to copy.ts",
      "",
    ].join("\n"));

    expect(diff.files).toEqual([
      {
        oldPath: "old.ts",
        newPath: "new.ts",
        status: "renamed",
        binary: false,
        hunks: [],
        oldChangedRanges: [],
        newChangedRanges: [],
        additions: 0,
        deletions: 0,
      },
      {
        oldPath: "template.ts",
        newPath: "copy.ts",
        status: "copied",
        binary: false,
        hunks: [],
        oldChangedRanges: [],
        newChangedRanges: [],
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  test("preserves binary and header-only modifications", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/image.png b/image.png",
      "index 123..456 100644",
      "Binary files a/image.png and b/image.png differ",
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n"));

    expect(diff.files).toMatchObject([
      {
        oldPath: "image.png",
        newPath: "image.png",
        status: "modified",
        binary: true,
        hunks: [],
      },
      {
        oldPath: "script.sh",
        newPath: "script.sh",
        status: "modified",
        binary: false,
        hunks: [],
      },
    ]);
  });

  test("decodes quoted paths including spaces and git octal UTF-8", () => {
    const diff = parseReviewScopeDiff([
      'diff --git "a/src/caf\\303\\251 file.ts" "b/src/caf\\303\\251 file.ts"',
      '--- "a/src/caf\\303\\251 file.ts"',
      '+++ "b/src/caf\\303\\251 file.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      'diff --git "a/old name.ts" "b/new name.ts"',
      "similarity index 100%",
      'rename from "old name.ts"',
      'rename to "new name.ts"',
      "",
    ].join("\n"));

    expect(diff.files[0]).toMatchObject({
      oldPath: "src/café file.ts",
      newPath: "src/café file.ts",
    });
    expect(diff.files[1]).toMatchObject({
      oldPath: "old name.ts",
      newPath: "new name.ts",
      status: "renamed",
    });
  });
});

describe("aggregateReviewScope", () => {
  const nodes: ReviewScopeAtlasNode[] = [
    { id: "root", path: "", kind: "root", parentId: null, lines: 200 },
    { id: "src", path: "src", kind: "directory", parentId: "root", lines: 150 },
    { id: "feature", path: "src/feature", kind: "directory", parentId: "src", lines: 100 },
    { id: "a", path: "src/feature/a.ts", kind: "file", parentId: "feature", lines: 80 },
    { id: "b", path: "src/b.ts", kind: "file", parentId: "src", lines: 50 },
  ];

  test("rolls mapped file metrics through nested Atlas parents", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/src/feature/a.ts b/src/feature/a.ts",
      "--- a/src/feature/a.ts",
      "+++ b/src/feature/a.ts",
      "@@ -10,2 +10,3 @@",
      "-old",
      "+new",
      "+more",
      " context",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n"));
    const scope = aggregateReviewScope(diff, nodes);

    expect(scope.fileNodeIds).toEqual({
      "src/feature/a.ts": "a",
      "src/b.ts": "b",
    });
    expect(scope.nodeMetrics.a).toEqual({
      changedFiles: 1,
      directChangedFiles: 1,
      additions: 2,
      deletions: 1,
      changedLines: 3,
      density: 3 / 81,
    });
    expect(scope.nodeMetrics.feature).toMatchObject({
      changedFiles: 1,
      directChangedFiles: 0,
      additions: 2,
      deletions: 1,
      changedLines: 3,
    });
    expect(scope.nodeMetrics.src).toMatchObject({
      changedFiles: 2,
      directChangedFiles: 0,
      additions: 3,
      deletions: 2,
      changedLines: 5,
    });
    expect(scope.nodeMetrics.root).toMatchObject({
      changedFiles: 2,
      additions: 3,
      deletions: 2,
      changedLines: 5,
    });
    expect(scope.unmappedFiles).toEqual([]);
  });

  test("reports deleted and non-indexed files without losing global totals", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "deleted file mode 100644",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "diff --git a/generated/output.ts b/generated/output.ts",
      "--- a/generated/output.ts",
      "+++ b/generated/output.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"));
    const scope = aggregateReviewScope(diff, nodes);

    expect(scope.totals).toEqual({
      changedFiles: 2,
      additions: 1,
      deletions: 3,
      changedLines: 4,
    });
    expect(scope.nodeMetrics).toEqual({});
    expect(scope.unmappedFiles.map(({ file, reason }) => ({
      path: file.newPath ?? file.oldPath,
      reason,
    }))).toEqual([
      { path: "src/deleted.ts", reason: "deleted" },
      { path: "generated/output.ts", reason: "not-indexed" },
    ]);
  });

  test("maps a header-only rename while keeping its density at zero", () => {
    const renamedNodes = [
      ...nodes,
      {
        id: "renamed",
        path: "src/renamed.ts",
        kind: "file" as const,
        parentId: "src",
        lines: 20,
      },
    ];
    const diff = parseReviewScopeDiff([
      "diff --git a/src/original.ts b/src/renamed.ts",
      "similarity index 100%",
      "rename from src/original.ts",
      "rename to src/renamed.ts",
      "",
    ].join("\n"));
    const scope = aggregateReviewScope(diff, renamedNodes);

    expect(scope.nodeMetrics.renamed).toEqual({
      changedFiles: 1,
      directChangedFiles: 1,
      additions: 0,
      deletions: 0,
      changedLines: 0,
      density: 0,
    });
    expect(scope.nodeMetrics.src).toMatchObject({
      changedFiles: 1,
      changedLines: 0,
      density: 0,
    });
  });

  test("caps density for rewrites larger than the current file", () => {
    const diff = parseReviewScopeDiff([
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,60 +1,60 @@",
      ...Array.from({ length: 60 }, (_, index) => `-old ${index}`),
      ...Array.from({ length: 60 }, (_, index) => `+new ${index}`),
      "",
    ].join("\n"));
    const scope = aggregateReviewScope(diff, nodes);
    expect(scope.nodeMetrics.b?.density).toBe(1);
  });
});
