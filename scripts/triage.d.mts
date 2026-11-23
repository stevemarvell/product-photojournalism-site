export interface Issue {
  number: number;
  title: string;
  labels: string[];
  body?: string;
  user?: { login?: string };
  authorAssociation?: string;
}
export interface PullRequest {
  number: number;
  body?: string;
}
export interface Planned {
  number: number;
  title: string;
  rank: string;
  attempts?: number;
}
export interface Plan {
  work: Planned[];
  notReady: { number: number; title: string; reason: string }[];
  skip: { number: number; title: string; reason: string; author?: string; association?: string }[];
}
export declare const FETCH_LIMIT: number;
export declare const PAGE_SIZE: number;
export declare const MAX_PAGES: number;
export declare const ATTEMPT_MARKER: string;
export declare const MAX_ATTEMPTS: number;
export declare function authorClause(logins: string[]): string;
export declare function loginOption(argv?: string[], env?: Record<string, string | undefined>): string | undefined;
export declare function trustedLogins(
  run?: (args: string[]) => string,
  options?: { login?: string; warn?: (message: string) => void },
): string[];
export declare function attemptLookup(run?: (args: string[]) => string, logins?: string[]): (number: number) => number;
export declare function gh(args: string[]): string;
export declare function fetchOpen(
  run?: (args: string[]) => string,
  maxPages?: number,
): { issues: Issue[]; pullRequests: PullRequest[]; truncated: boolean };
export declare function claimedIssues(pullRequests: PullRequest[]): Map<number, number>;
export declare function openDependencies(issue: Issue, openNumbers: Set<number>): number[];
export declare function trusted(issue: Issue, permissionOf?: (login: string) => string): boolean;
export declare function permissionLookup(run?: (args: string[]) => string): (login: string) => string;
export declare function readiness(issue: Issue): string | null;
export declare function triage(
  issues: Issue[],
  pullRequests: PullRequest[],
  permissionOf?: (login: string) => string,
  attemptsOf?: (number: number) => number,
): Plan;
export declare function render(plan: Plan, options?: { truncated?: boolean }): string;
