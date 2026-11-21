import type { Project } from '../../scripts/project.mjs';

export declare const ROOT: string;

export interface BootstrapFs {
  exists(path: string): boolean;
  mtimeMs(path: string): number;
}

export declare function upToDate(root: string, project: Project, fs?: BootstrapFs): boolean;
