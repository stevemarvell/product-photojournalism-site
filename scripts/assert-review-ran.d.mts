export declare const UNREADABLE: unique symbol;
export declare function reviewVerdict(input?: {
  kind?: string;
  conclusion?: string;
  execution?: unknown[] | null | typeof UNREADABLE;
  workflowChanged?: boolean | null;
}): { ok: boolean; headline: string; detail: string };
export declare function readExecution(path: string): unknown[] | null | typeof UNREADABLE;
export declare function readFlag(value: string | undefined): boolean | null;
