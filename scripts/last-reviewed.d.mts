export declare const REVIEW_JOBS: string[];
export declare const MAX_RUNS: number;
export interface Run { id?: number; status: string; head_sha: string }
export declare const ASSERT_STEP: string;
export interface Step { name: string; conclusion: string | null }
export interface Job { name: string; conclusion: string | null; steps?: Step[] }
export declare function isReview(jobs: Job[] | undefined): boolean;
export declare function lastReviewed(
  runs: Run[] | null | undefined,
  jobsFor: (run: Run) => Job[] | undefined,
): { state: 'reviewed' | 'pending' | 'none'; sha?: string };
