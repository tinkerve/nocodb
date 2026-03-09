// Define the interface for the request object with possible nested structure
import { Logger } from '@nestjs/common';
import { logflow, timeit } from './processUtils';

interface XcRequest {
  [key: string]: XcRequest | 1 | true;
}

const logger = new Logger('nocoExecute');

// Helper function to flatten a nested array recursively
const flattenArray = (res) => {
  return Array.isArray(res) ? res.flatMap((r) => flattenArray(r)) : res;
};

export type ResolverObj =
  | {
      __proto__?: { __columnAliases?: { [key: string]: any } };
    } & {
      [key: string]: null | ((args: any) => any) | any;
    };

const nocoExecute = async (
  requestObj: XcRequest,
  resolverObj?: ResolverObj | ResolverObj[],
  dataTree = {},
  rootArgs = null,
): Promise<any> => {
  // (count: 999) This took about 2-3s (Original - Used with optimization)
  return nocoExecuteImpl(requestObj, resolverObj, dataTree, rootArgs);
  // (count: 999) This took about 4s (Non-Cached version by Gemini)
  // return nocoExecuteNoDataTree(requestObj, resolverObj, rootArgs);
  // return fastNocoV1(requestObj, resolverObj, rootArgs);
};
/**
 * Execute the request object
 * @param requestObj request object
 * @param resolverObj resolver object which may contain resolver functions or data
 * @param dataTree data tree that holds the state of the resolved data
 * @param rootArgs root arguments passed for nested processing
 * @returns Promise<any> returns the resolved data
 **/
const nocoExecuteImpl = async (
  requestObj: XcRequest,
  resolverObj?: ResolverObj | ResolverObj[],
  dataTree = {},
  rootArgs = null,
): Promise<any> => {
  // Handle array of resolvers by executing nocoExecute on each and returning a Promise.all
  if (Array.isArray(resolverObj)) {
    return Promise.all(
      resolverObj.map((resolver, i) =>
        nocoExecuteSingle(
          requestObj,
          resolver,
          (dataTree[i] = dataTree[i] || {}),
          rootArgs,
        ),
      ),
    );
  } else {
    return nocoExecuteSingle(requestObj, resolverObj, dataTree, rootArgs);
  }
};
const nocoExecuteSingle = async (
  requestObj: XcRequest,
  resolverObj?: ResolverObj,
  dataTree = {},
  rootArgs = null,
): Promise<any> => {
  const res = {};

  /**
   * Recursively extract nested data from the dataTree and resolve it.
   * @param path the path of keys to traverse in the data tree
   * @param dataTreeObj the current data tree object
   * @param resolver the resolver object to call functions or return values
   * @param args arguments passed to resolver functions
   * @returns Promise resolving the nested value
   */
  const extractNested = (
    path: string[],
    dataTreeObj: any,
    resolver: ResolverObj = {},
    args = {},
  ): any => {
    if (path.length) {
      const key = path[0];
      // If key doesn't exist in dataTree, resolve using resolver or create a placeholder
      if (dataTreeObj[key] === undefined || dataTreeObj[key] === null) {
        if (typeof resolver[key] === 'function') {
          // Call resolver function
          dataTreeObj[key] = timeit('extractNested call resolver', () =>
            resolver[key](args),
          );
        } else if (typeof resolver[key] === 'object') {
          dataTreeObj[key] = Promise.resolve(resolver[key]); // Resolve object directly
        } else if (dataTreeObj?.__proto__?.__columnAliases?.[key]) {
          // Handle column alias lookup
          dataTreeObj[key] = extractNested(
            dataTreeObj?.__proto__?.__columnAliases?.[key]?.path,
            dataTreeObj,
            {},
            args,
          );
        } else {
          if (typeof dataTreeObj === 'object') {
            dataTreeObj[key] = Promise.resolve(resolver[key]);
          }
        }
      } else if (typeof dataTreeObj[key] === 'function') {
        // If the key is a function, invoke it with args
        dataTreeObj.__proto__ = {
          ...dataTreeObj.__proto__,
          [key]: timeit('extractNested call dataTree', () =>
            dataTreeObj[key](args),
          ),
        };
      }

      // Recursively handle nested arrays or resolve promises
      return (
        dataTreeObj[key] instanceof Promise
          ? dataTreeObj[key]
          : Promise.resolve(dataTreeObj[key])
      ).then((res1) => {
        if (Array.isArray(res1)) {
          return Promise.all(
            res1.map((r) => extractNested(path.slice(1), r, {}, args)),
          );
        } else {
          return res1 !== null && res1 !== undefined
            ? extractNested(path.slice(1), res1, {}, args)
            : Promise.resolve(null);
        }
      });
    } else {
      return Promise.resolve(dataTreeObj); // If path is exhausted, return data tree object
    }
  };

  /**
   * Extract the value for the given key from the resolver object or data tree.
   * If the key is a function, call it with args, otherwise resolve the value.
   * @param key the key to extract
   * @param args the arguments for nested extractions
   */
  function extractField(key, args) {
    // Check if the key is a column alias or needs to be resolved
    if (!resolverObj?.__proto__?.__columnAliases?.[key]) {
      if (resolverObj) {
        // Resolve if it's a function, object, or value
        if (typeof resolverObj[key] === 'function') {
          res[key] = timeit('extractField call resolver', () =>
            resolverObj[key](args),
          ); // Call function
        } else if (typeof resolverObj[key] === 'object') {
          res[key] = Promise.resolve(resolverObj[key]); // Resolve object
        } else {
          try {
            res[key] = Promise.resolve(resolverObj[key]); // Resolve value
          } catch (e) {
            logger.error(e);
          }
        }
      }

      dataTree[key] = res[key]; // Store result in dataTree
    } else {
      // If nested, extract the nested value using extractNested function
      res[key] = extractNested(
        resolverObj?.__proto__?.__columnAliases?.[key]?.path,
        dataTree,
        resolverObj,
        args?.nested?.[key],
      ).then((res1) => {
        return Promise.resolve(
          // Flatten the array if it's nested
          Array.isArray(res1) ? flattenArray(res1) : res1,
        );
      });
    }
  }

  // Determine which keys to extract from the request object or resolver object
  // TODO: So this steps seems to be getting what attributes are requested
  // TODO: this could be precomputed once
  const extractKeys =
    requestObj && typeof requestObj === 'object'
      ? Object.keys(requestObj).filter((k) => requestObj[k])
      : Object.keys(resolverObj);

  const out: any = {}; // Holds the final output
  const resolPromises = []; // Holds all the promises for asynchronous resolution
  for (const key of extractKeys) {
    // Extract the field for each key
    extractField(key, rootArgs?.nested?.[key]);

    // Handle nested request objects by recursively calling nocoExecute
    if (requestObj[key] && typeof requestObj[key] === 'object') {
      // How does it know that this is a promise though-
      res[key] = res[key].then((res1) => {
        if (Array.isArray(res1)) {
          // Handle arrays of results by executing nocoExecute on each element
          return (dataTree[key] = Promise.all(
            res1.map((r, i) =>
              nocoExecuteImpl(
                requestObj[key] as XcRequest,
                r,
                dataTree?.[key]?.[i],
                Object.assign(
                  {
                    nestedPage: rootArgs?.nestedPage,
                    limit: rootArgs?.nestedLimit,
                  },
                  rootArgs?.nested?.[key] || {},
                ),
              ),
            ),
          ));
        } else if (res1) {
          // Handle single objects
          return (dataTree[key] = nocoExecuteImpl(
            requestObj[key] as XcRequest,
            res1,
            dataTree[key],
            Object.assign(
              {
                nestedPage: rootArgs?.nestedPage,
                limit: rootArgs?.nestedLimit,
              },
              rootArgs?.nested?.[key] || {},
            ),
          ));
        }
        return res1; // Return result if no further nesting
      });
    }
    // Push resolved promises to resolPromises array
    if (res[key]) {
      resolPromises.push(
        (async () => {
          out[key] = await res[key];
        })(),
      );
    }
  }

  // Wait for all promises to resolve before returning the final output
  await Promise.all(resolPromises);

  return out; // Return the final resolved output
};

export { nocoExecute };

async function fastNocoV1(
  requestObj: XcRequest,
  resolverObj?: ResolverObj | ResolverObj[],
  // NOTE: I think dataTree is used to keep "current progress" as function calls.
  // dataTree = {},
  rootArgs: any = {},
) {
  if (!resolverObj) return {}; // TODO: Need to doublecheck this
  if (Array.isArray(resolverObj))
    return Promise.all(resolverObj.map((o, i) => fastNocoV1(requestObj, o)));

  // TODO: need to dispatch these also to reduce the recomputation of this
  const requestFields = requestObj
    ? Object.keys(requestObj).filter((k) => requestObj[k])
    : Object.keys(resolverObj);

  const tasks = [] as (() => Promise<any>)[];
  const scheduleTask = (fn: () => Promise<any>) => {
    tasks.push(fn);
  };
  const flushTasks = () => Promise.all(tasks.map((t) => t()));

  type ProcessTask = {
    key: string;
    src: Record<string, any>;
    dest: Record<string, any>;
    req: XcRequest[keyof XcRequest];
  };
  const queue = [] as Array<ProcessTask>;
  const computed = {};
  // TODO: need to initialize the task queue

  // TODO: reconcile and dispatch, I think that's the pattern here.
  // TODO: somehow need to statically analyse this and dispatch tasks in threads.. I think
  while (queue.length > 0) {
    const { key: fieldName, src, dest, req } = queue.pop()!;
    const aliases = resolverObj?.__proto__?.__columnAliases;

    // For fields
    const alias: string | undefined = aliases?.[fieldName];
    const aliasPath: string[] | undefined = aliases?.[fieldName]?.path;
    const dataOrResolver = src[fieldName];
    const resolverArgs = rootArgs?.nested?.[fieldName];

    switch (true) {
      case !alias: {
        dest[fieldName] =
          typeof dataOrResolver === 'function'
            ? dataOrResolver(resolverArgs ?? {})
            : dataOrResolver;
        break;
      }
      case !isNil(alias): {
        // dest[fieldName] = extractNested here...
        // NOTE: I think this is resolved nested
        break;
      }
    }
  }

  // TODO: maybe should make recursive manually (using queue)
  for (const fieldName of requestFields) {
    if (!requestObj[fieldName]) {
      logger.warn(`Unable to process field '${fieldName}'`);
      continue;
    }

    const fieldAlias: string | undefined =
      resolverObj?.__proto__?.__columnAliases?.[fieldName];
    const fieldAliasPath: string[] | undefined =
      resolverObj?.__proto__?.__columnAliases?.[fieldName]?.path;
    const fieldDataOrResolver = resolverObj[fieldName];
    const fieldArgs = rootArgs?.nested?.[fieldName];

    switch (true) {
      case !fieldAlias: {
        computed[fieldName] =
          typeof fieldDataOrResolver === 'function'
            ? fieldDataOrResolver(fieldArgs ?? {})
            : fieldDataOrResolver;
        break;
      }
      case !isNil(fieldAlias): {
        // TODO: resolve path (but this should probably be deferred since it has await)
        const path = fieldAliasPath ?? [];

        let sourceResolverObjPtr = resolverObj; // Points to whatever is nested now
        let outPtr = computed;
        for (const key of path) {
          const nestedDataOrResolver = sourceResolverObjPtr[key];
          const nestedFieldAlias: string | undefined =
            sourceResolverObjPtr?.__proto__?.__columnAliases?.[key];
          const nestedFieldAliasPath: string | undefined =
            sourceResolverObjPtr?.__proto__?.__columnAliases?.[key].path;

          // TODO: extract nested func needs the additional arguments
          // TODO: continue here, follow the condition in `extractNested`
          switch (true) {
            case typeof nestedDataOrResolver === 'function': {
              outPtr[key] = nestedDataOrResolver(
                Object.assign({
                  ...(fieldArgs ?? {}),
                  nestedPage: rootArgs?.nestedPage,
                  limit: rootArgs?.nestedLimit,
                }),
              );
            }
            case !isNil(nestedFieldAlias): {
              // TODO: this needs recursion fak (maybe use the queue system)
              break;
            }
            default: {
              outPtr[key] = nestedDataOrResolver;
            }
          }
        }

        break;
      }
    }

    // TODO: no longer sure what this is
    if (typeof requestObj[fieldName] === 'object')
      scheduleTask(async () => {
        computed[fieldName] = await fastNocoV1(
          requestObj[fieldName] as XcRequest,
          computed[fieldName],
        );
      });
  }

  await flushTasks();
  return computed;
}

// TODO: This is only to validate if this outputs right
async function nocoExecuteNoDataTree(
  requestObj: any,
  resolverObj?: ResolverObj | ResolverObj[],
  rootArgs = null,
) {
  if (Array.isArray(resolverObj))
    return await Promise.all(
      resolverObj.map((o, i) => nocoExecuteNoDataTree(requestObj, o)),
    );

  const out: any = {};
  const resolveValue = (source: any, key: string, args: any) => {
    if (!source || source[key] === undefined) return null;
    return typeof source[key] === 'function' ? source[key](args) : source[key];
  };

  const resolvePath = async (
    path: string[],
    currentSource: any,
    args: any,
  ): Promise<any> => {
    if (!path.length || !currentSource) return currentSource;

    const [key, ...remainingPath] = path;
    const value = await resolveValue(currentSource, key, args);

    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item) => resolvePath(remainingPath, item, args)),
      );
    }
    return resolvePath(remainingPath, value, args);
  };

  const keys =
    requestObj && typeof requestObj === 'object'
      ? Object.keys(requestObj).filter((k) => requestObj[k])
      : Object.keys(resolverObj || {});
  for (const key of keys) {
    let resolvedValue: any;
    const alias = resolverObj?.__proto__?.__columnAliases?.[key];
    const fieldArgs = rootArgs?.nested?.[key];

    // 1. Resolve the raw value (either via Alias path or direct key)
    if (alias?.path) {
      const nestedResult = await resolvePath(
        alias.path,
        resolverObj,
        fieldArgs,
      );
      resolvedValue = Array.isArray(nestedResult)
        ? flattenArray(nestedResult)
        : nestedResult;
    } else {
      resolvedValue = await resolveValue(resolverObj, key, fieldArgs);
    }

    // 2. Handle Recursion if the request object has nested requirements for this key
    if (
      requestObj[key] &&
      typeof requestObj[key] === 'object' &&
      resolvedValue
    ) {
      const nestedParams = {
        nestedPage: rootArgs?.nestedPage,
        limit: rootArgs?.nestedLimit,
        ...(rootArgs?.nested?.[key] || {}),
      };

      resolvedValue = await nocoExecuteNoDataTree(
        requestObj[key],
        resolvedValue,
        nestedParams,
      );
    }

    out[key] = resolvedValue;
  }

  return out;
}

function isNil<T>(o: T): o is T & {} {
  return o !== undefined && o !== null;
}

function logAllProperties(obj) {
  if (obj == null) return; // recursive approach
  console.log(Object.getOwnPropertyNames(obj));
  logAllProperties(Object.getPrototypeOf(obj));
}
