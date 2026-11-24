export type RunResult = { status: number; stdout: string; stderr: string };
export type Run = (args: string[]) => Promise<RunResult>;

export interface PullRequest {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefName: string;
  headRefOid?: string;
  mergeable?: string;
  /** Check runs plus commit statuses on the head commit; only set for an open pull request. */
  checks?: number;
}

export interface BranchWithAhead {
  name: string;
  ahead: number | null;
  /** The production branch carries content `develop` lacks. */
  backMerge?: boolean;
}

export interface OrphanedBranch {
  name: string;
  ahead: number;
  where: string;
  /** Set on the production branch when its content differs from develop: it needs a back-merge pull request. */
  backMerge?: boolean;
}

export interface Worktree {
  path: string;
  branch: string | null;
  /** The commit the worktree is at; `null` if git printed none. */
  head?: string | null;
}

export interface UntrackedWorktree {
  name: string;
  entryCount: number;
  /** `null` means unknown — `git status` itself failed, most likely because this is not a git checkout any more. */
  hasChanges: boolean | null;
}

export interface MergedWorktree {
  path: string;
  branch: string;
  pr: number;
}

export interface StalePullRequest {
  number: number;
  title: string;
  reasons: string[];
}

export interface Findings {
  orphanedBranches: OrphanedBranch[];
  untrackedWorktrees: UntrackedWorktree[];
  /** Plain files directly in `.claude/worktrees/`, as repo-relative paths (#414). */
  strayFiles?: string[];
  mergedWorktrees: MergedWorktree[];
  staleOrConflicting: StalePullRequest[];
  noChecksRegistered: PullRequest[];
}

export declare const MAX_MERGES_BEHIND: number;
export declare const WORKTREES_DIR: string;
export declare const PR_PAGE_SIZE: number;
export declare const MAX_PR_PAGES: number;
export declare const MERGEABLE_ATTEMPTS: number;
export declare const MERGEABLE_WAIT_MS: number;
export declare function gh(args: string[]): Promise<RunResult>;
export declare function git(args: string[]): Promise<RunResult>;
export declare function localBranches(run: Run): Promise<string[]>;
export declare function remoteBranches(run: Run): Promise<string[]>;
export declare function aheadCount(run: Run, develop: string, ref: string): Promise<number | null>;
export declare function contentAhead(run: Run, develop: string, ref: string): Promise<boolean | null>;
export declare function behindMergeCount(run: Run, develop: string, ref: string): Promise<number | null>;
export declare function parseWorktreeList(porcelain: string): Worktree[];
export declare function worktreeList(run: Run): Promise<Worktree[]>;
export declare function allPullRequests(run: Run, maxPages?: number): Promise<PullRequest[]>;
export declare function openPullRequestDetail(
  run: Run,
  pr: PullRequest,
  options?: { sleep?: (ms: number) => Promise<void>; attempts?: number },
): Promise<{ mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; checks: number }>;
export declare function orphanedBranches(
  branches: { local?: BranchWithAhead[]; remote?: BranchWithAhead[] },
  prs: PullRequest[],
): OrphanedBranch[];
export declare function untrackedWorktreeFolders(diskNames: string[], registeredPaths: string[]): string[];
export declare function mergedWorktrees(worktrees: Worktree[], prs: PullRequest[]): MergedWorktree[];
export declare function staleOrConflicting(prs: PullRequest[], behind?: Map<number, number | null>): StalePullRequest[];
export declare function noChecksRegistered(prs: PullRequest[]): PullRequest[];
export declare function isEmpty(findings: Findings): boolean;
export declare function find(options?: {
  gh?: Run;
  git?: Run;
  develop?: string;
  worktreesDir?: string;
  readDir?: (dir: string) => string[];
  readFiles?: (dir: string) => string[];
  gitStatus?: (dir: string) => Promise<boolean | null>;
  sleep?: (ms: number) => Promise<void>;
  productionBranch?: string;
}): Promise<Findings>;
export declare function renderFindings(findings: Findings): string[];
export declare function render(findings: Findings): string;
