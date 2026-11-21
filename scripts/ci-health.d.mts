export interface Job {
  status?: string;
  conclusion?: string | null;
  runner_id?: number | null;
  runner_name?: string | null;
}
export declare function ciDidNotRun(jobs: Job[] | null | undefined): boolean;
