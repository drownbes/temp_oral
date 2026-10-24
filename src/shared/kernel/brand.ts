declare const brand: unique symbol;

/** Nominal typing for primitives: `Brand<string, 'SourceId'>` is not assignable from `string`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
