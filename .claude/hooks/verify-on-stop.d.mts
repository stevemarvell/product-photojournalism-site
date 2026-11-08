export declare const ROOT: string;
export declare const MAX_CONSECUTIVE_BLOCKS: number;
export declare const STATE_DIR: string;
export declare function changedFiles(paths?: string[]): string[];
export declare function decide(input: { green: boolean; previous: number; continuing: boolean }): {
  action: 'allow' | 'block' | 'report';
  count: number | null;
};
export declare function parseStopInput(raw: string): { sessionId: unknown; continuing: boolean };
export declare function statePath(sessionId: unknown, dir?: string): string;
export declare function readCount(path: string): number;
export declare function writeCount(path: string, count: number | null): void;
