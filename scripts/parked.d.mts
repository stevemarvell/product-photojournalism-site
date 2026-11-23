export interface Parked {
  number: number;
  reason: string;
  files: string[];
  claims: number[];
}
export declare const MAX_PULLS: number;
export declare const STOP_PREFIX: string;
export declare function stopFilter(logins: string[]): string;
export declare function stopHead(body: string | undefined): string | null;
export declare function namesPath(text: string, file: string): boolean;
export declare function isParked(
  stops: { created_at: string; body: string }[],
  commitDates: string[],
  headSha?: string,
): { created_at: string; body: string } | null;
export declare function listParked(
  run: ((args: string[]) => string) | undefined,
  logins: string[],
): { parked: Parked[]; files: string[]; more: boolean };
export declare function overlaps(body: string | undefined, parked: Parked[]): number[];
export declare function render(result: { parked: Parked[]; files: string[]; more: boolean }): string;
