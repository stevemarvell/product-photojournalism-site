import type { Project } from './project.mjs';

export const FULL: string;
export function commandsFor(changed: string[], project: Project): string[];
export function changedFiles(): string[];
export function planFrom(
  getChanged: () => string[],
  project: Project,
): { commands: string[]; warning: string | null };
export function unionChanged(diffOut: string, statusRaw: string): string[];
