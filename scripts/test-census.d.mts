export interface Census {
  counts: Record<string, number>;
  tabular: Record<string, string[]>;
  total: number;
}
export declare const ACKNOWLEDGEMENT: RegExp;
export declare function isTestFile(path: string): boolean;
export declare function countTests(
  path: string,
  source: string,
): { count: number; tabular: string[] };
export declare function census(files: Record<string, string>): Census;
export declare function censusVerdict(input?: {
  base?: Partial<Census> | null;
  head?: Partial<Census> | null;
  body?: string;
}): { ok: boolean; removed: number; headline: string; detail: string };
export declare function treeAt(ref: string): Promise<Census>;
