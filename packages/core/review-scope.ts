/**
 * Browser-safe parsing and Atlas aggregation for a review-wide change scope.
 *
 * This module deliberately describes only facts present in the unified diff
 * and current Atlas tree. Symbol mapping and inferred semantic impact build on
 * this contract separately.
 */

export type ReviewScopeFileStatus =
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "modified";

export interface ReviewScopeLineRange {
  /** Inclusive, one-based source line. */
  startLine: number;
  /** Inclusive, one-based source line. */
  endLine: number;
}

export interface ReviewScopeHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldChangedRanges: ReviewScopeLineRange[];
  newChangedRanges: ReviewScopeLineRange[];
  additions: number;
  deletions: number;
}

export interface ReviewScopeFileChange {
  oldPath?: string;
  newPath?: string;
  status: ReviewScopeFileStatus;
  binary: boolean;
  hunks: ReviewScopeHunk[];
  oldChangedRanges: ReviewScopeLineRange[];
  newChangedRanges: ReviewScopeLineRange[];
  additions: number;
  deletions: number;
}

export interface ReviewScopeDiff {
  files: ReviewScopeFileChange[];
  totals: ReviewScopeChangeMetrics;
}

export interface ReviewScopeAtlasNode {
  id: string;
  path: string;
  kind: "root" | "directory" | "file";
  parentId: string | null;
  lines: number;
}

export interface ReviewScopeChangeMetrics {
  changedFiles: number;
  additions: number;
  deletions: number;
  changedLines: number;
}

export interface ReviewScopeNodeMetrics extends ReviewScopeChangeMetrics {
  /** Changed files whose current-tree file node is this node. */
  directChangedFiles: number;
  /** Changed lines divided by current lines plus deleted lines, capped at 1. */
  density: number;
}

export type ReviewScopeUnmappedReason =
  | "deleted"
  | "missing-current-path"
  | "not-indexed";

export interface ReviewScopeUnmappedFile {
  file: ReviewScopeFileChange;
  reason: ReviewScopeUnmappedReason;
}

export interface ReviewScopeAggregation {
  totals: ReviewScopeChangeMetrics;
  nodeMetrics: Record<string, ReviewScopeNodeMetrics>;
  fileNodeIds: Record<string, string>;
  unmappedFiles: ReviewScopeUnmappedFile[];
}

interface PathPair {
  oldPath?: string;
  newPath?: string;
}

interface MutableMetrics extends ReviewScopeChangeMetrics {
  directChangedFiles: number;
}

const EMPTY_METRICS: MutableMetrics = {
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  changedLines: 0,
  directChangedFiles: 0,
};

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

const C_ESCAPES: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  const decoder = new TextDecoder();
  let output = "";
  let pendingBytes: number[] = [];

  const flush = (): void => {
    if (pendingBytes.length === 0) return;
    output += decoder.decode(new Uint8Array(pendingBytes));
    pendingBytes = [];
  };

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]!;
    if (character !== "\\") {
      flush();
      output += character;
      continue;
    }

    const next = inner[index + 1];
    if (next && next >= "0" && next <= "7") {
      let octal = "";
      let cursor = index + 1;
      while (
        cursor < inner.length &&
        octal.length < 3 &&
        inner[cursor]! >= "0" &&
        inner[cursor]! <= "7"
      ) {
        octal += inner[cursor]!;
        cursor += 1;
      }
      pendingBytes.push(parseInt(octal, 8) & 0xff);
      index = cursor - 1;
      continue;
    }

    if (next && next in C_ESCAPES) {
      flush();
      output += String.fromCharCode(C_ESCAPES[next]!);
      index += 1;
      continue;
    }

    if (
      next === "u" &&
      /^[0-9a-fA-F]{4}$/.test(inner.slice(index + 2, index + 6))
    ) {
      flush();
      output += String.fromCharCode(
        parseInt(inner.slice(index + 2, index + 6), 16),
      );
      index += 5;
      continue;
    }

    flush();
    output += "\\";
  }

  flush();
  return output;
}

function scanToken(input: string): { token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  if (!trimmed.startsWith('"')) {
    const space = trimmed.indexOf(" ");
    return space === -1
      ? { token: trimmed, rest: "" }
      : { token: trimmed.slice(0, space), rest: trimmed.slice(space + 1) };
  }

  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return {
        token: trimmed.slice(0, index + 1),
        rest: trimmed.slice(index + 1),
      };
    }
  }
  return null;
}

function stripPathPrefix(token: string, side: "a" | "b"): string | undefined {
  const withoutMetadata = token.startsWith('"')
    ? token
    : token.split("\t", 1)[0]!;
  if (withoutMetadata === "/dev/null") return undefined;
  const path = unquoteGitPath(withoutMetadata);
  const prefix = `${side}/`;
  return path.startsWith(prefix) ? normalizePath(path.slice(prefix.length)) : undefined;
}

function parseDiffHeader(line: string): PathPair {
  if (!line.startsWith("diff --git ")) return {};
  const first = scanToken(line.slice("diff --git ".length));
  const second = first ? scanToken(first.rest) : null;
  if (!first || !second) return {};
  return {
    oldPath: stripPathPrefix(first.token, "a"),
    newPath: stripPathPrefix(second.token, "b"),
  };
}

function parseFileMarker(line: string, side: "a" | "b"): string | undefined {
  const token = scanToken(line.slice(4))?.token;
  return token ? stripPathPrefix(token, side) : undefined;
}

function parseMetadataPath(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const token = line.slice(prefix.length);
  if (token === "/dev/null") return undefined;
  return normalizePath(unquoteGitPath(token));
}

function appendLine(ranges: ReviewScopeLineRange[], line: number): void {
  const previous = ranges[ranges.length - 1];
  if (previous && previous.endLine + 1 === line) {
    previous.endLine = line;
    return;
  }
  ranges.push({ startLine: line, endLine: line });
}

function mergeRanges(
  ranges: Iterable<ReviewScopeLineRange>,
): ReviewScopeLineRange[] {
  const ordered = [...ranges]
    .map((range) => ({ ...range }))
    .sort((first, second) =>
      first.startLine - second.startLine || first.endLine - second.endLine
    );
  const merged: ReviewScopeLineRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function parseHunk(lines: string[], startIndex: number): {
  hunk: ReviewScopeHunk;
  nextIndex: number;
} | null {
  const match = HUNK_HEADER.exec(lines[startIndex] ?? "");
  if (!match) return null;

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const oldChangedRanges: ReviewScopeLineRange[] = [];
  const newChangedRanges: ReviewScopeLineRange[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let additions = 0;
  let deletions = 0;
  let index = startIndex + 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-") && !line.startsWith("--- ")) {
      appendLine(oldChangedRanges, oldLine);
      oldLine += 1;
      deletions += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++ ")) {
      appendLine(newChangedRanges, newLine);
      newLine += 1;
      additions += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return {
    hunk: {
      oldStart,
      oldCount,
      newStart,
      newCount,
      oldChangedRanges,
      newChangedRanges,
      additions,
      deletions,
    },
    nextIndex: index,
  };
}

function splitFileChunks(patch: string): string[] {
  const starts = [...patch.matchAll(/^diff --git /gm)].map(
    (match) => match.index ?? 0,
  );
  return starts.map((start, index) =>
    patch.slice(start, starts[index + 1] ?? patch.length)
  );
}

function parseFileChunk(chunk: string): ReviewScopeFileChange | null {
  const lines = chunk.split(/\r?\n/);
  const headerPaths = parseDiffHeader(lines[0] ?? "");
  let oldPath = headerPaths.oldPath;
  let newPath = headerPaths.newPath;
  let status: ReviewScopeFileStatus = "modified";
  let binary = false;
  const hunks: ReviewScopeHunk[] = [];

  for (let index = 1; index < lines.length;) {
    const line = lines[index]!;
    if (line.startsWith("new file mode ")) {
      status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = parseMetadataPath(line, "rename from ") ?? oldPath;
    } else if (line.startsWith("rename to ")) {
      status = "renamed";
      newPath = parseMetadataPath(line, "rename to ") ?? newPath;
    } else if (line.startsWith("copy from ")) {
      status = "copied";
      oldPath = parseMetadataPath(line, "copy from ") ?? oldPath;
    } else if (line.startsWith("copy to ")) {
      status = "copied";
      newPath = parseMetadataPath(line, "copy to ") ?? newPath;
    } else if (line.startsWith("--- ")) {
      oldPath = parseFileMarker(line, "a") ?? oldPath;
    } else if (line.startsWith("+++ ")) {
      newPath = parseFileMarker(line, "b") ?? newPath;
    } else if (
      line === "GIT binary patch" ||
      line.startsWith("Binary files ")
    ) {
      binary = true;
    } else if (line.startsWith("@@ ")) {
      const parsed = parseHunk(lines, index);
      if (parsed) {
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
        continue;
      }
    }
    index += 1;
  }

  if (status === "added") oldPath = undefined;
  if (status === "deleted") newPath = undefined;
  if (
    status === "modified" &&
    oldPath &&
    newPath &&
    oldPath !== newPath
  ) {
    status = "renamed";
  }
  if (!oldPath && !newPath) return null;

  const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
  const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
  return {
    ...(oldPath && { oldPath }),
    ...(newPath && { newPath }),
    status,
    binary,
    hunks,
    oldChangedRanges: mergeRanges(
      hunks.flatMap((hunk) => hunk.oldChangedRanges),
    ),
    newChangedRanges: mergeRanges(
      hunks.flatMap((hunk) => hunk.newChangedRanges),
    ),
    additions,
    deletions,
  };
}

export function parseReviewScopeDiff(patch: string): ReviewScopeDiff {
  const files = splitFileChunks(patch)
    .map(parseFileChunk)
    .filter((file): file is ReviewScopeFileChange => file !== null);
  const totals = files.reduce<ReviewScopeChangeMetrics>(
    (result, file) => ({
      changedFiles: result.changedFiles + 1,
      additions: result.additions + file.additions,
      deletions: result.deletions + file.deletions,
      changedLines:
        result.changedLines + file.additions + file.deletions,
    }),
    { changedFiles: 0, additions: 0, deletions: 0, changedLines: 0 },
  );
  return { files, totals };
}

function addMetrics(
  metrics: MutableMetrics,
  file: ReviewScopeFileChange,
  direct: boolean,
): void {
  metrics.changedFiles += 1;
  metrics.additions += file.additions;
  metrics.deletions += file.deletions;
  metrics.changedLines += file.additions + file.deletions;
  if (direct) metrics.directChangedFiles += 1;
}

export function aggregateReviewScope(
  diff: ReviewScopeDiff,
  nodes: readonly ReviewScopeAtlasNode[],
): ReviewScopeAggregation {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fileByPath = new Map(
    nodes
      .filter((node) => node.kind === "file")
      .map((node) => [normalizePath(node.path), node]),
  );
  const mutable = new Map<string, MutableMetrics>();
  const fileNodeIds: Record<string, string> = {};
  const unmappedFiles: ReviewScopeUnmappedFile[] = [];

  const metricsFor = (id: string): MutableMetrics => {
    const current = mutable.get(id);
    if (current) return current;
    const created = { ...EMPTY_METRICS };
    mutable.set(id, created);
    return created;
  };

  for (const file of diff.files) {
    if (!file.newPath) {
      unmappedFiles.push({ file, reason: "deleted" });
      continue;
    }
    const normalizedPath = normalizePath(file.newPath);
    if (!normalizedPath) {
      unmappedFiles.push({ file, reason: "missing-current-path" });
      continue;
    }
    const fileNode = fileByPath.get(normalizedPath);
    if (!fileNode) {
      unmappedFiles.push({ file, reason: "not-indexed" });
      continue;
    }

    fileNodeIds[normalizedPath] = fileNode.id;
    addMetrics(metricsFor(fileNode.id), file, true);
    const visited = new Set<string>([fileNode.id]);
    let parentId = fileNode.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      addMetrics(metricsFor(parentId), file, false);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  const nodeMetrics: Record<string, ReviewScopeNodeMetrics> = {};
  for (const [id, metrics] of mutable) {
    const node = byId.get(id);
    const denominator = Math.max(1, (node?.lines ?? 0) + metrics.deletions);
    nodeMetrics[id] = {
      ...metrics,
      density: Math.min(1, metrics.changedLines / denominator),
    };
  }

  return {
    totals: { ...diff.totals },
    nodeMetrics,
    fileNodeIds,
    unmappedFiles,
  };
}
