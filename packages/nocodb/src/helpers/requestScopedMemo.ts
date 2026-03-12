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
interface MemoNode {
  key: any;
  value: any | null;
  next: MemoNode[];
}
const memoStorage = new AsyncLocalStorage<MemoNode>();
const ROOT = Symbol('memo-root');
const NOT_FOUND = Symbol('memo-not-found');

const LOG_ENABLED = false;
const doNothing = () => {};
const logger = LOG_ENABLED
  ? new Logger(`RequestScopedMemo`)
  : { debug: doNothing };

export class RequestScopedMemo {
  static create(next: () => any) {
    return memoStorage.run(
      {
        key: ROOT,
        value: null,
        next: [],
      },
      () => next(),
    );
  }

  static isEnabled() {
    const store = memoStorage.getStore();
    return store !== undefined;
  }

  static use<T>(key: any[], value: () => T) {
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

  static get(key: any[]) {
    const store = memoStorage.getStore();
    if (!store) return NOT_FOUND;

    // Walk to the three to find the node
    let current = store;
    for (const k of key) {
      // NOTE: not the most efficient but it'll work for now...
      const nextNode = current.next.find((n) => isEqual(k, n.key));
      if (!nextNode) {
        logger.debug(`Not found in cache for ${key}`);
        return NOT_FOUND;
      }
      current = nextNode;
    }

    logger.debug(`Cache hit ${key} ${current.value}`);
    return current.value;
  }
  static set<T>(key: any[], value: T) {
    const store = memoStorage.getStore();
    if (!store) return value;

    // Recursively create node
    let current = store;
    for (const k of key) {
      // NOTE: not the most efficient but it'll work for now...
      const nextNode = current.next.find((n) => isEqual(k, n.key));
      if (!nextNode) {
        const next: MemoNode = {
          key: k,
          value: null,
          next: [],
        };
        current.next.push(next);
        current = next;
      } else current = nextNode;
    }

    logger.debug(`Memoised ${key} ${value}`);
    current.value = value;
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

export function Memoable(): MethodDecorator {
  return (target, property, descriptor) => {
    const originalFn = (descriptor.value as AnyFn) ?? (() => {});
    descriptor.value = function (this: any, ...args: any[]) {
      const methodKey = (target as AnyFn)?.name ?? target.constructor.name;
      const cacheKey = [methodKey, ...args];
      return RequestScopedMemo.use(cacheKey, () =>
        originalFn.apply(this, args),
      );
    } as any;
  };
}
