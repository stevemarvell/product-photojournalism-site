export interface PullRequest {
  number: number;
  title?: string;
  headRefOid?: string;
}
export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  failed?: boolean;
}
export interface Verdict {
  ok: boolean;
  state: 'base' | 'rivals' | 'clear' | 'unknown';
  headline: string;
  detail: string;
}
export declare const MAX_PULL_REQUESTS: number;
export declare const MARKER: string;
export declare function parseMergeTree(status: number, stdout: string): MergeResult;
export declare function mergeConflicts(
  a: string,
  b: string,
  run?: (args: string[]) => Promise<{ status: number; stdout: string }>,
): Promise<MergeResult>;
export declare function partitionConflicts(paths: string[]): {
  tests: string[];
  sources: string[];
};
export declare function selectPullRequests(
  list: PullRequest[],
  max?: number,
): { selected: PullRequest[]; truncated: number };
export declare function reportingTargets(list: PullRequest[], only?: number[]): PullRequest[];
export declare function refsToFetch(list: PullRequest[], only?: number[]): string[];
export declare function contentionVerdict(input?: {
  subject?: PullRequest;
  base?: { ref?: string; conflicts?: string[]; failed?: boolean };
  rivals?: { number: number; title?: string; conflicts: string[]; failed?: boolean }[];
  truncated?: number;
}): Verdict;
export declare function commentBody(verdict: Verdict): string;
export declare function commentAction(input?: {
  existing?: { id: number; body: string } | null;
  verdict: Verdict;
}): { method: 'POST' | 'PATCH'; id?: number; body: string } | null;
