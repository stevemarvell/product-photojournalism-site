export interface Issue {
  number: number;
  title: string;
  labels: string[];
  body?: string;
}
export interface PullRequest {
  number: number;
  body?: string;
}
export interface Planned {
  number: number;
  title: string;
  rank: string;
}
export interface Plan {
  work: Planned[];
  deferred: Planned[];
  skip: { number: number; title: string; reason: string }[];
}
export declare const MAX_ISSUES_PER_RUN: number;
export declare const FETCH_LIMIT: number;
export declare const PAGE_SIZE: number;
export declare const MAX_PAGES: number;
export declare function gh(args: string[]): string;
export declare function fetchOpen(
  run?: (args: string[]) => string,
  maxPages?: number,
): { issues: Issue[]; pullRequests: PullRequest[]; truncated: boolean };
export declare function claimedIssues(pullRequests: PullRequest[]): Map<number, number>;
export declare function openDependencies(issue: Issue, openNumbers: Set<number>): number[];
export declare function triage(issues: Issue[], pullRequests: PullRequest[], max?: number): Plan;
export declare function render(plan: Plan, options?: { truncated?: boolean }): string;
