export function commitJson(env: Record<string, string | undefined>): string;
export function commitFile(env?: Record<string, string | undefined>): {
  name: string;
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): void }): void;
};
