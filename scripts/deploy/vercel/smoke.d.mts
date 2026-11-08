export type Git = (args: string[]) => { status: number };
export declare function buildIsEquivalent(options: { git: Git; pathspecs: string[]; deployedSha: string; sha: string }): boolean;
