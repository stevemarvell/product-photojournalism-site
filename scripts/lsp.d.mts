export declare const LANGUAGE_SERVERS: Record<string, string[]>;
export declare function onPath(
  command: string,
  exec?: (command: string, options: { stdio: 'ignore' }) => unknown,
): boolean;
export declare function missingPackages(isOnPath?: (command: string) => boolean): string[];
