import type {
  AvailableBranches,
  JjEvoLogEntry,
  RecentCommit,
} from '@plannotator/shared/types';

export type BaseStepDirection = -1 | 1;

function adjacent<T>(
  values: readonly T[],
  selectedIndex: number,
  direction: BaseStepDirection,
): T | null {
  if (selectedIndex < 0) return null;
  return values[selectedIndex + direction] ?? null;
}

export function stepGitReviewBase(
  selectedBase: string,
  direction: BaseStepDirection,
  availableBranches: AvailableBranches,
  recentCommits: readonly RecentCommit[],
): string | null {
  const commitIndex = recentCommits.findIndex(
    (commit) => commit.sha === selectedBase || commit.shortSha === selectedBase,
  );
  if (commitIndex !== -1) {
    return adjacent(recentCommits, commitIndex, direction)?.sha ?? null;
  }

  const branches = [...new Set([
    ...availableBranches.local,
    ...availableBranches.remote,
  ])];
  return adjacent(branches, branches.indexOf(selectedBase), direction);
}

export function stepJjEvolutionBase(
  selectedBase: string,
  direction: BaseStepDirection,
  entries: readonly JjEvoLogEntry[],
): string | null {
  const selectedIndex = entries.findIndex((entry) => entry.commitId === selectedBase);
  return adjacent(entries, selectedIndex, direction)?.commitId ?? null;
}
