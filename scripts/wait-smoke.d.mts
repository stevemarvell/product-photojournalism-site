import type { Run } from './wait-checks.mjs';

export type SmokeJudgement = { state: 'pass' | 'fail' | 'pending'; run: number | null };
export type SmokeResult =
  | (SmokeJudgement & { sha: string; attempts: number })
  | { state: 'not-merged'; sha: string; run: null; attempts: number; message: string };

export declare const SMOKE_ATTEMPTS: number;
export declare const INTERVAL_MS: number;
export declare class NotMergedError extends Error {}
export declare function judge(workflowRuns?: { id: number; status: string; conclusion?: string | null }[]): SmokeJudgement;
export declare function readSmoke(run: Run, pull: number | string): Promise<SmokeJudgement & { sha: string }>;
export declare function waitSmoke(
  pull: number | string,
  options?: {
    gh?: Run;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    intervalMs?: number;
    log?: (line: string) => void;
  },
): Promise<SmokeResult>;
export declare function render(result: SmokeResult): string;
export declare function exitCode(result: SmokeResult): 0 | 1 | 2 | 64;
