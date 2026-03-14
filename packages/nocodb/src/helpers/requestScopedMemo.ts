import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

const isEqual = (a: any, b: any) => {
  if (typeof a !== typeof b) return false;
  // TODO: this should probably be deep compare
  return Object.is(a, b);
};

/**
 * Enables request-scoped memoisation. The idea is that we can memoise similar request to the database
 * within the same request processing window to minimize latency. In the original context, it is to minimize
 * calls to NocoDB given the same table and view. (since nocodb is slow)
 */
const memoStorage = new AsyncLocalStorage<Record<string, any>>();
const ROOT = Symbol('memo-root');
const NOT_FOUND = Symbol('memo-not-found');

const LOG_ENABLED = false;
const doNothing = () => {};
const logger = LOG_ENABLED
  ? new Logger(`RequestScopedMemo`)
  : { debug: doNothing };

export class RequestScopedMemo {
  static create(next: () => any) {
    return memoStorage.run({}, () => next());
  }

  static isEnabled() {
    const store = memoStorage.getStore();
    return store !== undefined;
  }

  static use<T>(key: string, value: () => T) {
    if (!RequestScopedMemo.isEnabled()) return value();

    const stored = RequestScopedMemo.get(key);
    switch (stored) {
      case NOT_FOUND: {
        const returnVal = value();
        RequestScopedMemo.set(key, returnVal);
        return returnVal;
      }
      default: {
        return stored;
      }
    }
  }

  static get(key: string) {
    const store = memoStorage.getStore();
    if (!store) return NOT_FOUND;
    return store[key] ?? NOT_FOUND;
  }
  static set<T>(key: string, value: T) {
    const store = memoStorage.getStore();
    if (!store) return value;
    store[key] = value;
    return value;
  }
}

type AnyFn = (...args: any[]) => any;
export function WithRequestScopedMemo(): MethodDecorator {
  return (target, property, descriptor) => {
    const originalFn = (descriptor.value as AnyFn) ?? (() => {});
    descriptor.value = function (this: any, ...args: any[]) {
      return RequestScopedMemo.create(() => originalFn.apply(this, args));
    } as any;
  };
}
