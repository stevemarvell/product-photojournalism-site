export declare const GOVERNANCE: string;
export declare function canonical(path: string): string;
export declare function isProse(path: string): boolean;
export declare function isWorkflow(path: string): boolean;
export declare const COMPARE_FILE_CAP: number;
export declare function printable(text: string): string;
export declare function needsSecurityRereview(paths: Iterable<string>): boolean;
export declare function reviewScope(paths: Iterable<string>): {
  code: boolean;
  security: boolean;
  workflows: boolean;
  why: string;
};
