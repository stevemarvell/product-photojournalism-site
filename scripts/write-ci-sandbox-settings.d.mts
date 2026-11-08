export declare function ciSandboxSettings(): {
  enabled: boolean;
  failIfUnavailable: boolean;
  allowUnsandboxedCommands: boolean;
  network: {
    strictAllowlist: boolean;
    allowedDomains: string[];
  };
};

export declare function mergeCiSandboxSettings(path: string): {
  path: string;
  sandbox: ReturnType<typeof ciSandboxSettings>;
};
