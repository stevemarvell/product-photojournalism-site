import type { Project } from './project.mjs';

export type FetchJson = (url: string) => Promise<unknown>;
export type Git = (args: string[]) => { status: number; stdout: string };
export interface Result {
  ok: boolean;
  reason: string;
}
export declare const GATE_ATTEMPTS: number;
export declare const GATE_INTERVAL_MS: number;
export declare function appUrls(project: Project): Record<string, string>;
export declare function waitForCommit(options: {
  project: Project;
  name: string;
  sha: string;
  fetchJson: FetchJson;
  git: Git;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  attempts?: number;
}): Promise<Result>;
export declare function gateForEvent(eventName: string | undefined): boolean;
export declare function smoke(options: {
  project: Project;
  sha: string | undefined;
  fetchJson: FetchJson;
  git: Git;
  sleep: (ms: number) => Promise<void>;
  run: (script: string, urls: Record<string, string>) => number;
  log: (line: string) => void;
  gate?: boolean;
}): Promise<Result>;
export declare function runGit(args: string[], cwd?: string): { status: number; stdout: string };
export declare function isCommitSha(value: unknown): boolean;

export declare function branchOfRef(ref: string | undefined): string | null;
export declare function notProductionBranch(args: { project: Project; ref: string | undefined; eventName: string | undefined }): string | null;
export declare function isDevelopPush(options: { project: Project; ref: string | undefined; eventName: string | undefined }): boolean;
export declare function developProject(project: Project): Project;
