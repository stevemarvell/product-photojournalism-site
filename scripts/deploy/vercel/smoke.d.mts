import type { Project } from '../../project.mjs';
export type Git = (args: string[]) => { status: number; stdout: string };
export declare function buildIsEquivalent(options: { git: Git; project: Project; name: string; deployedSha: string; sha: string }): boolean;
export declare function branchAlias(deploy: { project: string; team: string }, branch: string): string;
