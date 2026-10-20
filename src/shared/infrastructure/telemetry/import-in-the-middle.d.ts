// import-in-the-middle ships register-hooks.d.ts, but without an exports map TypeScript
// looks for register-hooks.d.mts. Mirrors the shipped declaration.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
    disableCjsSourceStripping?: boolean;
  }): void;
  export function supportsSyncHooks(): boolean;
}
