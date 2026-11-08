export declare const ROOT: string;
export declare const FILTERS: {
  name: string;
  match: (command: string) => boolean;
  filter: string;
}[];
export declare function filterCommand(
  command: unknown,
): { name: string; command: string } | null;
export declare function decide(payload: unknown): Record<string, unknown>;
