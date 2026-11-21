export declare const TELEMETRY_KEYS: string[];
export declare function isTelemetryKey(key: string): boolean;
export declare function repoTelemetryEnv(repoDir: string): Record<string, string>;
export declare function defaultUserSettingsPath(env?: Record<string, string | undefined>): string;
export declare function writeUserTelemetrySettings(
  repoDir: string,
  userPath?: string,
): { path: string; keys: string[] };
