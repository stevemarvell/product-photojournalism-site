import type { Project } from '../../scripts/project.mjs';

export declare const ROOT: string;

export interface FixCommand {
  command: string;
  args: string[];
}

export declare function fixCommands(filePath: string, project?: Project): FixCommand[];

export declare function runFixes(
  filePath: string,
  options?: { exec?: (command: string, args: string[], options: unknown) => unknown; project?: Project },
): void;
