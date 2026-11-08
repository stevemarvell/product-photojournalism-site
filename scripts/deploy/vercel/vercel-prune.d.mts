export interface Deployment {
  uid?: string;
  id?: string;
  target?: string | null;
  state?: string;
  readyState?: string;
  created?: number;
  createdAt?: number;
  meta?: { githubCommitRef?: string; githubCommitSha?: string };
}
export type Rule = { branch: string; live?: undefined } | { live: Set<string>; branch?: undefined };
export type FetchJson = (
  url: string,
) => Promise<{ deployments: Deployment[]; pagination?: { next?: number | null }; deploymentId?: string }>;

export declare const TEAM: string | undefined;
export declare const PROJECTS: string[];
export declare const PRODUCTION_BRANCH: string;
export declare const MAX_PAGES: number;
export declare const KEEP_PRODUCTION: number;
export declare const TARGETS: { project: string; host: string }[];
export declare function selectHistory(deployments: Deployment[], options: { liveId?: string; keep?: number }): Deployment[];
export declare function pruneHistory(options: {
  fetchJson: FetchJson;
  remove: (id: string) => Promise<unknown>;
  dryRun?: boolean;
  log?: (line: string) => void;
  targets?: { project: string; host: string }[];
  keep?: number;
}): Promise<{ project: string; id: string; state: string }[]>;
export declare function isPreview(deployment: Deployment): boolean;
export declare function select(deployments: Deployment[], rule: Rule): Deployment[];
export declare function listDeployments(fetchJson: FetchJson, project: string, branch?: string, target?: string): Promise<Deployment[]>;
export declare function main(argv: string[], env: Record<string, string | undefined>): Promise<void>;
export declare function prune(options: {
  fetchJson: FetchJson;
  remove: (id: string) => Promise<unknown>;
  rule: Rule;
  dryRun?: boolean;
  log?: (line: string) => void;
  projects?: string[];
}): Promise<{ project: string; id: string; branch: string }[]>;
