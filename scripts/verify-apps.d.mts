import type { Project } from './project.mjs';

export interface Step {
  app: string;
  cwd: string;
  command: string;
}
export declare function plan(project: Project, names?: string[]): Step[];
export declare function run(
  steps: Step[],
  options?: { exec?: (command: string, options: { cwd: string; stdio: 'inherit' }) => unknown; log?: (line: string) => void },
): Step | null;
export declare function nothingToRun(project: Project, steps: Step[]): string | null;
