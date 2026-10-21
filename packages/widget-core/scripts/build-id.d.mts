// Types for build-id.mjs, imported by vite.config.ts and test/build-id.test.ts.
export const HASH_LENGTH: number;
export const SLOT: string;
export function releaseVersion(): string;
export function placeholder(version?: string): string;
export function stamp(dir: string, version?: string): string;
