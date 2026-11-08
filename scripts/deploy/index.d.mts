import * as vercel from './vercel/index.mjs';

export declare const PROVIDERS: { vercel: typeof vercel };
export declare function provider(name: string): typeof vercel;
