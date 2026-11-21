import type { App, Project } from './project.mjs';

export interface Starter {
  description: string;
  app: string;
  files: string[];
  build: string[];
}
export interface Section {
  description: string;
  paths: string[];
}
export interface Provider {
  description: string;
  path: string;
  template: string;
}
export interface Catalogue {
  ignoredNames: string[];
  engine: Section;
  seeded: Section;
  generated: Section;
  base: Section;
  starters: Record<string, Starter>;
  providers: Record<string, Provider>;
}
export interface Limits {
  depth: number;
  files: number;
}
export interface PlanEntry {
  to: string;
  from?: string;
  content?: string;
  source: string;
}
export interface PlanOptions {
  root?: string;
  catalogue?: Catalogue;
  name: string;
  starters: string[];
  engineCommit?: string;
  limits?: Limits;
}
export interface AssembleResult {
  target: string;
  files: string[];
  project: Project;
}
export type { App };
export declare const ROOT: string;
export declare function trackedFiles(root: string): string[];
export declare const CATALOGUE: string;
export declare const LIMITS: Limits;
export declare const GENERATORS: Record<string, unknown>;
export declare function validateCatalogue(catalogue: unknown): Catalogue;
export declare function loadCatalogue(path?: string): Catalogue;
export declare function under(prefix: string, path: string): boolean;
export declare function sharedBlock(claudeMd: string): string;
export interface DependabotParts {
  header: string[];
  entries: { ecosystem: string; lines: string[] }[];
}
export declare function splitDependabot(source: string): DependabotParts;
export declare function dependabotYml(source: string, options: { python: boolean }): string;
export declare function checkTarget(target: string, root: string): void;
export declare function plan(options: PlanOptions): { entries: PlanEntry[]; project: Project };
export declare function writeEntries(root: string, where: string, entries: PlanEntry[]): void;
export declare function assemble(options: PlanOptions & { target: string }): AssembleResult;
export declare function parseArgs(argv: string[]): { list?: boolean; target?: string; name?: string; engineCommit?: string; starters: string[] };
