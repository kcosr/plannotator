import { describe, expect, test } from 'bun:test';
import type {
  AvailableBranches,
  JjEvoLogEntry,
  RecentCommit,
} from '@plannotator/shared/types';
import { stepGitReviewBase, stepJjEvolutionBase } from './baseNavigation';

const branches: AvailableBranches = {
  local: ['feature', 'main'],
  remote: ['origin/feature', 'origin/main'],
};

const commits: RecentCommit[] = [
  {
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortSha: 'aaaaaaa',
    subject: 'Newest',
    relativeDate: 'now',
    author: 'Ada',
  },
  {
    sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    shortSha: 'bbbbbbb',
    subject: 'Older',
    relativeDate: 'earlier',
    author: 'Grace',
  },
];

describe('review base keyboard navigation', () => {
  test('steps commits without crossing into branches', () => {
    expect(stepGitReviewBase(commits[0].sha, 1, branches, commits)).toBe(commits[1].sha);
    expect(stepGitReviewBase(commits[1].shortSha, -1, branches, commits)).toBe(commits[0].sha);
    expect(stepGitReviewBase(commits[1].sha, 1, branches, commits)).toBeNull();
  });

  test('steps branches without crossing into commits', () => {
    expect(stepGitReviewBase('main', -1, branches, commits)).toBe('feature');
    expect(stepGitReviewBase('main', 1, branches, commits)).toBe('origin/feature');
    expect(stepGitReviewBase('origin/main', 1, branches, commits)).toBeNull();
  });

  test('does not guess the domain of an unknown ref', () => {
    expect(stepGitReviewBase('HEAD~7', 1, branches, commits)).toBeNull();
  });

  test('steps jj evolution entries independently', () => {
    const entries: JjEvoLogEntry[] = [
      { commitId: 'current', description: 'Current' },
      { commitId: 'previous', description: 'Previous' },
    ];
    expect(stepJjEvolutionBase('current', 1, entries)).toBe('previous');
    expect(stepJjEvolutionBase('previous', -1, entries)).toBe('current');
  });
});
