import type { Project } from './project.mjs';

export declare function installCommands(project: Project): string[];
export declare const STAMP: string;
export declare function writeStamps(root: string, project: Project, stderr?: { write(s: string): unknown }): void;
export declare const ROOT: string;
export declare function bootstrap(options: {
  root?: string;
  project?: Project;
  run: (command: string) => void;
  packages?: string[];
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
}): void;
