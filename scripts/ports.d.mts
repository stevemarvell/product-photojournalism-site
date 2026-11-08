export declare const BASE_PORT: number;
export declare const BAND: number;
export declare function portOffset(root?: string): number;
export declare function ports<N extends string>(names: readonly N[], root?: string): Record<N, number>;
