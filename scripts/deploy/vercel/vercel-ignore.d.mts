import type { Project } from '../../project.mjs';

export type Git = (args: string[]) => { status: number; stdout: string };
export declare function forkPoint(git: Git): string | null;
export declare function decide(
  project: string,
  env: Record<string, string | undefined>,
  git: Git,
  manifest?: Project,
): { build: boolean; reason: string };
