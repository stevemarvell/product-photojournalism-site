export interface Deploy {
  provider: string;
  team: string;
  project: string;
  url: string;
  commitEndpoint: string;
  templateHashes?: Record<string, string>;
}
export interface App {
  path: string;
  toolchain: 'python' | 'node';
  reads: string[];
  verify?: string[];
  ignores?: string[];
  services?: 'postgres'[];
  deploy?: Deploy;
  smoke?: string;
}
export interface Engine {
  commit: string;
}
export interface Project {
  name: string;
  engine?: Engine;
  apps: Record<string, App>;
}
export declare const ROOT: string;
export declare const MANIFEST: string;
export declare const HARNESS_CODE: string[];
export declare const TEMPLATE_HASH_KEYS: readonly string[];
export declare function inside(parent: string, child: unknown): boolean;
export declare function validate(project: unknown): Project;
export declare function loadProject(path?: string): Project;
export declare function apps(project: Project, toolchain?: string): [string, App][];
export declare function deployed(project: Project): [string, App][];
export declare function hasDeploy(project: Project): boolean;
export declare function hasService(project: Project, service: string): boolean;
export declare function hasE2e(project: Project): boolean;
export declare function appFor(project: Project, relativePath: string): [string, App] | null;
export declare function buildPathspecs(project: Project, name: string): string[] | null;
export declare function buildInputsChanged(options: {
  git: (args: string[]) => { status: number; stdout: string };
  project: Project;
  name: string;
  base: string;
  head: string;
}): 'unchanged' | 'changed' | 'failed';
export declare function verifiedPaths(project: Project): string[];
export declare function cli(argv: string[], project?: Project): string[];
