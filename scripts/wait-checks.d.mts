export type RunResult = { status: number; stdout: string; stderr: string };
export type Run = (args: string[]) => Promise<RunResult>;
export type CheckRun = { name: string; status: string; conclusion?: string | null };
export type Judgement = { state: 'pass' | 'fail' | 'pending'; failed: string[] };
export type WaitResult = Judgement & { sha: string; attempts: number };

export declare const CHECK_ATTEMPTS: number;
export declare const INTERVAL_MS: number;
export declare function gh(args: string[]): Promise<RunResult>;
export declare const MAX_NAME_LENGTH: number;
export declare function cleanName(name: unknown): string;
export declare function judge(checkRuns?: CheckRun[]): Judgement;
export declare function readChecks(run: Run, pull: number | string): Promise<Judgement & { sha: string }>;
export declare function waitChecks(
  pull: number | string,
  options?: {
    gh?: Run;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    intervalMs?: number;
    log?: (line: string) => void;
  },
): Promise<WaitResult>;
export declare function render(result: WaitResult): string;
export declare function exitCode(result: WaitResult): 0 | 1 | 2;
