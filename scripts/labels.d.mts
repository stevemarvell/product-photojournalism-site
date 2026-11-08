export interface Label {
  name: string;
  color: string;
  description: string;
}
export type LabelAction = Label & { action: 'create' | 'update' };
export type RunResult = { status: number; stdout: string; stderr: string };
export type Run = (args: string[]) => Promise<RunResult>;

export declare const MANIFEST: string;
export declare function validate(manifest: unknown): Label[];
export declare function loadManifest(path?: string): Label[];
export declare function plan(manifest: Label[], existing: Label[]): LabelAction[];
export declare function gh(args: string[]): Promise<RunResult>;
export declare const LABEL_PAGE_SIZE: number;
export declare const MAX_LABEL_PAGES: number;
export declare function listLabels(run: Run, repo?: string, maxPages?: number): Promise<Label[]>;
export declare function writeArgs(label: LabelAction, repo?: string): string[];
export declare function apply(options: {
  run?: Run;
  manifest: Label[];
  repo?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<LabelAction[]>;
export declare function main(argv: string[]): Promise<void>;
