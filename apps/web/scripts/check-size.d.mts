export declare const LIMIT_BYTES: number;
export declare function entryScripts(html: string): string[];
export declare function measure(dist: string): { bytes: number; files: string[] };
export declare function check(dist: string, limit?: number): { ok: boolean; message: string };
