/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Thin wrapper around `require('debug')` extracted so tests can mock the
 * peer-dependency resolution without having to intercept a bare `require()`
 * call inside a class constructor.
 */
export function loadDebug(): (namespace: string) => (...args: unknown[]) => void {
  return require('debug') as (namespace: string) => (...args: unknown[]) => void;
}
