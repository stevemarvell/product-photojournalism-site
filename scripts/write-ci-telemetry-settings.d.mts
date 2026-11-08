export declare function assertClean(value: string, context: string): void;
export declare function ciTelemetryEnv(env?: Record<string, string | undefined>): Record<string, string>;
export declare function defaultSettingsPath(env?: Record<string, string | undefined>): string;
export declare function writeCiTelemetrySettings(
  env?: Record<string, string | undefined>,
  path?: string,
): { path: string; enabled: boolean };
