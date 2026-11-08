export declare const REPO_ROOT: string;
export declare const DOCS_DIR: string;
export declare const MARKDOWN_PAGES: { slug: string; source: string; blurb: string }[];
export declare function page(options: {
  title: string;
  body: string;
  crumbs?: boolean;
  name: string;
}): string;
export declare function indexPage(
  rendered?: { slug: string; title: string; blurb: string }[],
  name?: string,
  options?: { stepZero?: boolean },
): string;
export declare function buildDocs(options?: {
  root?: string;
  out?: string;
  env?: Record<string, string | undefined>;
}): { out: string; written: string[]; skipped: string[] };
export declare function plannedPages(options?: { root?: string }): {
  pages: { slug: string; page: string; source: string; title: string | null; blurb?: string; markdown?: string }[];
  skipped: string[];
};
export declare function listing(options?: { root?: string }): string;
