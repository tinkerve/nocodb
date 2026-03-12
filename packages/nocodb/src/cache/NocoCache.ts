import RedisCacheMgr from './RedisCacheMgr';
import RedisMockCacheMgr from './RedisMockCacheMgr';
import type CacheMgr from './CacheMgr';
import { CACHE_PREFIX, CacheGetType, CacheScope } from '~/utils/globals';
import { getRedisURL } from '~/helpers/redisHelpers';
import { logflow, Time } from 'src/utils';
import { RequestScopedMemo } from 'src/helpers/requestScopedMemo';

const ENABLE_REQUEST_CACHE = false;

export default class NocoCache {
  private static client: CacheMgr;
  private static cacheDisabled: boolean;
  private static prefix: string;

  public static init() {
    this.cacheDisabled = (process.env.NC_DISABLE_CACHE || false) === 'true';
    if (this.cacheDisabled) {
      return;
    }
    if (getRedisURL()) {
      this.client = new RedisCacheMgr(getRedisURL());
    } else {
      this.client = new RedisMockCacheMgr();
    }

    // TODO(cache): fetch orgs once it's implemented
    const orgs = 'noco';
    this.prefix = `${CACHE_PREFIX}:${orgs}`;
  }

  public static disableCache() {
    this.cacheDisabled = true;
  }

  public static enableCache() {
    // return to default value
    this.cacheDisabled = (process.env.NC_DISABLE_CACHE || false) === 'true';
  }

  public static async set(key, value): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);

    if (ENABLE_REQUEST_CACHE && RequestScopedMemo.isEnabled()) {
      void this.client.set(`${this.prefix}:${key}`, value);
      RequestScopedMemo.set([`${this.prefix}:${key}`], value);
      return true;
    }

    return this.client.set(`${this.prefix}:${key}`, value);
  }

  public static async setExpiring(key, value, expireSeconds): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.setExpiring(
      `${this.prefix}:${key}`,
      value,
      expireSeconds,
    );
  }

  public static async incrby(key, value): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.incrby(`${this.prefix}:${key}`, value);
  }

  public static async get(key, type): Promise<any> {
    if (this.cacheDisabled) {
      if (type === CacheGetType.TYPE_ARRAY) return Promise.resolve([]);
      else if (type === CacheGetType.TYPE_OBJECT) return Promise.resolve(null);
      return Promise.resolve(null);
    }

    if (ENABLE_REQUEST_CACHE && RequestScopedMemo.isEnabled()) {
      // NOTE: I think this should return as it is and doesn't require casting
      return RequestScopedMemo.use([`${this.prefix}:${key}`], () =>
        this.client.get(`${this.prefix}:${key}`, type),
      );
    }

    return this.client.get(`${this.prefix}:${key}`, type);
  }

  public static async del(key): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    if (Array.isArray(key))
      return this.client.del(key.map((k) => `${this.prefix}:${k}`));
    return this.client.del(`${this.prefix}:${key}`);
  }

  // @Time()
  public static async getList(
    scope: string,
    subKeys: string[],
    orderBy?: {
      key: string;
      dir?: 'asc' | 'desc';
      isString?: boolean;
    },
  ): Promise<{
    list: any[];
    isNoneList: boolean;
  }> {
    if (this.cacheDisabled)
      return Promise.resolve({
        list: [],
        isNoneList: false,
      });

    if (ENABLE_REQUEST_CACHE && RequestScopedMemo.isEnabled()) {
      // NOTE: I think this should return as it is and doesn't require casting
      return RequestScopedMemo.use([scope, subKeys.join('')], () =>
        this.client.getList(scope, subKeys, orderBy),
      );
    }

    return this.client.getList(scope, subKeys, orderBy);
  }

  // @Time()
  public static async setList(
    scope: string,
    subListKeys: string[],
    list: any[],
    props: string[] = [],
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);

    if (ENABLE_REQUEST_CACHE && RequestScopedMemo.isEnabled()) {
      // TODO: what the fuck? this function definitely makes it faster/slower
      void this.client.setList(scope, subListKeys, list, props);

      const listKey =
        subListKeys.length === 0
          ? `${this.prefix}:${scope}:list`
          : `${this.prefix}:${scope}:${subListKeys.join(':')}:list`;
      this.set(listKey, {
        list,
        isNoneList: false,
      });
      for (const item of list) {
        let itemKey =
          props.length > 0
            ? `${this.prefix}:${scope}:${props.map((p) => item[p]).join(':')}`
            : `${this.prefix}:${scope}:${item?.id}`;
        this.set(itemKey, item);
      }

      return true;
    }

    return this.client.setList(scope, subListKeys, list, props);
  }

  public static async deepDel(
    key: string,
    direction: string,
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.deepDel(`${this.prefix}:${key}`, direction);
  }

  public static async appendToList(
    scope: string,
    subListKeys: string[],

    key: string,
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.appendToList(
      scope,
      subListKeys,
      `${this.prefix}:${key}`,
    );
  }

  public static async update(
    key: string,
    updateObj: Record<string, any>,
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.update(`${this.prefix}:${key}`, updateObj);
  }

  public static async setHash(
    key: string,
    hash: Record<string, any>,
    options: {
      ttl?: number;
    } = {},
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    if (Object.keys(hash).length === 0) {
      return;
    }
    return !!this.client.setHash(`${this.prefix}:${key}`, hash, options);
  }

  public static async getHash(
    key: string,
  ): Promise<Record<string, string | number>> {
    if (this.cacheDisabled) return Promise.resolve({});
    return this.client.getHash(`${this.prefix}:${key}`);
  }

  public static async getHashField(
    key: string,
    field: string,
  ): Promise<string> {
    if (this.cacheDisabled) return Promise.resolve(null);
    return this.client.getHashField(`${this.prefix}:${key}`, field);
  }

  public static async setHashField(
    key: string,
    field: string,
    value: string | number,
  ): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return !!this.client.setHashField(`${this.prefix}:${key}`, field, value);
  }

  public static async incrHashField(
    key: string,
    field: string,
    value: number,
  ): Promise<number> {
    if (this.cacheDisabled) return Promise.resolve(0);
    return this.client.incrHashField(`${this.prefix}:${key}`, field, value);
  }

  public static async keyExists(key: string): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(false);
    return this.client.keyExists(`${this.prefix}:${key}`);
  }

  public static async processPattern(
    pattern: string,
    callback: (key: string) => Promise<void>,
    options: { count?: number; type?: string } = {},
  ): Promise<void> {
    if (this.cacheDisabled) return Promise.resolve();
    return this.client.processPattern(
      `${this.prefix}:${pattern}`,
      callback,
      options,
    );
  }

  public static async destroy(): Promise<boolean> {
    if (this.cacheDisabled) return Promise.resolve(true);
    return this.client.destroy();
  }

  public static async export(): Promise<any> {
    if (this.cacheDisabled) return Promise.resolve({});
    return this.client.export();
  }
}
