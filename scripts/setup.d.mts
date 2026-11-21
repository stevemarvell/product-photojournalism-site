import type { Catalogue } from './assemble.d.mts';

export type RunResult = { status: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[]) => Promise<RunResult>;
export type Spawn = (cmd: string, args: string[], options?: Record<string, unknown>) => { status: number | null };

export interface CreateArgs {
  name: string;
  owner: string;
  dir: string;
  public: boolean;
  starters: string[];
  deploy?: string;
}
export interface CheckArgs {
  skipVerify: boolean;
  dryRun: boolean;
  repo?: string;
  /** Optional integrations to file issues for (`--with`). */
  with: string[];
}
export interface PreflightResult {
  name: string;
  ok: boolean;
  detail: string;
}
export interface CheckLine {
  mark: string;
  text: string;
}
export interface CheckResult {
  lines: string[];
  exitCode: number;
}
export interface OwnerIssue {
  title: string;
  rank: 'critical' | 'high' | 'medium';
  /** True when only the owner can do it (a login, money or a credential): filed `human`, assigned. False is agent work: rank label only, unassigned. */
  owner: boolean;
  /** Filed only when asked for with `check --with <name>`. */
  optional?: string;
  /** A repository secret this issue asks for; the issue is not filed while that secret is set. */
  secret?: string;
  /** The issue text for `repo` (`owner/name`), so printed commands carry `-R owner/name`. */
  body: (repo: string) => string;
}

/** The `owner/name` a github.com remote URL (scp-like, ssh or https) points at, or null. */
export declare function parseGithubRepo(url: string): string | null;

export declare const STORY_TEMPLATE_PATH: string;
export declare function storyTemplateBody(text?: string): string;
export declare const BASE_REMOTE: string;
export declare const PREFLIGHT_NODE_MAJOR: number;
export declare const MARK: { done: string; fixed: string; owner: string; info: string };
export declare const OWNER_ISSUES: OwnerIssue[];
export declare const OPTIONAL_NAMES: string[];
export declare const TEMPLATE_ISSUE_TITLE: string;
export declare const MAX_ISSUE_PAGES: number;

export declare function needsShell(cmd: string, platform?: string): boolean;
export declare function shellCommand(cmd: string, args: string[]): string;
export declare function exec(
  cmd: string,
  args: string[],
  opts?: { platform?: string; execFileImpl?: (...a: any[]) => unknown },
): Promise<RunResult>;
export declare function spawnTool(
  cmd: string,
  args: string[],
  options?: Record<string, unknown>,
  opts?: { platform?: string; spawnImpl?: (...a: any[]) => { status: number | null } },
): { status: number | null };

export declare function parseCreateArgs(argv: string[]): CreateArgs;
export declare function parseAddArgs(argv: string[]): { starters: string[] };
export declare function parseCheckArgs(argv: string[]): CheckArgs;

export declare function preflight(options?: { run?: Run; nodeVersion?: string; python?: boolean }): Promise<PreflightResult[]>;
export declare function missingPreflight(results: PreflightResult[]): PreflightResult[];

export declare function renderCheck(results: CheckLine[]): CheckResult;
export declare function branchProtectionDecision(options: { isPrivate: boolean }): CheckLine;
export declare function missingOwnerIssues(existingTitles: string[], options?: { secretNames?: Set<string>; withOptional?: string[] }): OwnerIssue[];
export declare function needsTemplateIssue(openIssues: { labels?: string[] }[]): boolean;

export declare function runCheck(options?: {
  repo?: string;
  root?: string;
  dryRun?: boolean;
  skipVerify?: boolean;
  withOptional?: string[];
  run?: Run;
  fetchUrl?: typeof fetch;
  runVerify?: () => number;
  runIdentityTest?: () => { ok: boolean; output: string };
}): Promise<CheckResult>;

export declare function engineDrift(options: { run: Run; root: string; commit: string }): Promise<CheckLine>;
export declare function checkOwner(owner: unknown): void;
export declare function checkChoices(options: { catalogue: Catalogue; starters: string[]; deploy?: string }): void;
export declare function withoutCredentials(url: string): string;
export declare function ensureEmptyTarget(options: { run: Run; target: string }): Promise<{ exists: boolean }>;
export declare function create(
  options: CreateArgs,
  deps?: { run?: Run; spawn?: Spawn; root?: string; log?: (line: string) => void },
): Promise<number>;
export declare function mergePackageJson(current: string, wanted: string): string | undefined;
export declare function alignPins(text: string, rootText: string | undefined): string;
export declare function add(
  options: { starters: string[] },
  deps?: { run?: Run; spawn?: Spawn; root?: string; log?: (line: string) => void },
): Promise<{ added: string[]; kept: string[] }>;
export declare function main(argv: string[]): Promise<number>;
