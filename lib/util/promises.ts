import { isFunction } from 'lodash';

export function isPromiseLike<P>(value: unknown): value is Promise<P> {
  if (typeof (value) === 'object' && value !== null) {
    return 'then' in value && isFunction(value.then);
  }
  return false;
}
