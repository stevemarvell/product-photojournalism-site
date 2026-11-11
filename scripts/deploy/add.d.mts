export interface DeployValues {
  team: string;
  project: string;
  url: string;
  commitEndpoint: string;
}
export interface AddDeployOptions {
  provider: string;
  app: string;
  team?: string;
  project?: string;
  url?: string;
  commitEndpoint?: string;
  overwrite?: boolean;
  root?: string;
  manifestPath?: string;
}

export declare function parseArgs(argv: string[]): { provider: string; app: string } & Partial<DeployValues> & { overwrite?: boolean };
export declare function withPlaceholders(options: Partial<DeployValues> & { existing?: Partial<DeployValues> }): DeployValues;
export declare function renderTemplate(text: string, values: Record<string, string>): string;
export declare function ownerSteps(options: { app: string; team: string; project: string }): string[];
export declare const SMOKE_EVERY_HOURS: number;
export declare const SMOKE_SCHEDULE: string;
export declare const smokeScheduleMessage: () => string;
export declare function hasSmokeSchedule(text: string): boolean;
export declare function smokeScheduleProblem(project: import('../project.mjs').Project, text: string): string | null;
export declare function withSmokeSchedule(text: string): string;
export declare function addDeploy(options: AddDeployOptions): { manifest: unknown; values: DeployValues; smoke: 'scheduled' | 'unchanged' | 'absent'; changed: Partial<Record<keyof DeployValues, { from: string; to: string }>>; files: { vercelJson: 'written' | 'kept'; skill: 'written' | 'kept' }; templateDrift: Partial<Record<'vercelJson' | 'skill', 'template-moved' | 'customised' | 'unknown'>> };
