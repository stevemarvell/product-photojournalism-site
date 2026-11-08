export declare const CLEAR_AT_PERCENT: number;
export declare const COLD_CACHE_CLEAR_AT_PERCENT: number;
export declare function clearAdvice(state: {
  contextPercent: number | null;
  cacheWarm?: boolean;
}): string | null;
export declare function render(payload: unknown): string;
