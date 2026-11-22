export type Run = (cmd: string, args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
export interface Pull {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  base?: { ref: string };
}
export declare const PAGE_LIMIT: number;
export declare function baseTag(date: Date | string): string;
export declare function nextTag(existingTags: string[], date: Date | string): string;
export declare function latestTag(tags: string[]): string | null;
export declare function releaseNotes(pulls: Pull[], options?: { since?: string | null; branch?: string }): string;
export declare function ownerSaidGo(options: { owner: string; comments: { user?: { login?: string }; body?: string; created_at?: string }[]; mergedBy?: string | null; after?: string | null }): boolean;
export declare function plan(options: { run: Run; repo: string; date: Date | string }): Promise<{ tag: string; last: string | null; notes: string }>;
export declare function goGiven(options: { run: Run; repo: string; pr: number | string }): Promise<{ given: boolean; sha: string }>;
export declare function tagRelease(options: { run: Run; repo: string; pr: number | string; date: Date | string }): Promise<{ tag: string; sha: string; url: string }>;
export declare const exec: Run;
