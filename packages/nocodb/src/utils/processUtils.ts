import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export function handleUncaughtErrors(process: NodeJS.Process) {
  process.on('uncaughtException', (err) => {
    let handled = false;
    if ((err as any).code) {
      switch ((err as any).code) {
        // ERR_STRING_TOO_LONG from pg-protocol cannot be caught, possibly because it has been
        // detached from process by setTimeout or setImmediate without promise
        case 'ERR_STRING_TOO_LONG':
          handled = true;
          break;
      }
    }
    if (!handled) {
      process.exit(1);
    }
  });
}

let executionId = 0;
const logger = new Logger('TIMEIT');
const execStorage = new AsyncLocalStorage<{
  level: number;
  // Array of string that is within the level I guess
  currentLevelLogStack: any[];
}>();

export function timeit<TReturn>(label: string, fn: () => TReturn): TReturn {
  const { level = 0, currentLevelLogStack = [] } = execStorage.getStore() ?? {};
  const padding = '  '.repeat(level);
  const nextLevelLogStack = [];

  return execStorage.run(
    {
      level: level + 1,
      currentLevelLogStack: nextLevelLogStack,
    },
    (): any => {
      const id = ++executionId;
      logger.debug(`${padding}(${id}) ${label} called`.padStart(level));

      const startTime = performance.now();
      const result = fn();
      const logEnd = () => {
        const endTime = performance.now();
        const durationInSeconds = (endTime - startTime) / 1000;
        const endLogMsg = `(${id}) ${label} took ${durationInSeconds.toFixed(
          3,
        )} s`;
        logger.debug(`${padding}${endLogMsg}`);

        currentLevelLogStack.push(endLogMsg);
        currentLevelLogStack.push(nextLevelLogStack);

        // If this is the root process, relog everything
        if (level === 0) {
          logger.debug('===========');
          logger.debug('Ordered Log:');
          const logLeveled = (l: any[], level = 0) => {
            for (const item of l)
              if (Array.isArray(item)) logLeveled(item, level + 1);
              else logger.debug(`${'  '.repeat(level)} ${item}`);
          };
          logLeveled(currentLevelLogStack);
        }
      };

      if (result instanceof Promise) {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises,no-async-promise-executor
        return new Promise(async (resolve, reject) => {
          try {
            const r = await result;
            logEnd();
            resolve(r);
          } catch (e) {
            reject(e);
          }
        });
      } else {
        logEnd();
        return result;
      }
    },
  );
}

export function Time(): MethodDecorator {
  return (target, property, descriptor) => {
    const fn = descriptor.value as (...args: any[]) => any;
    descriptor.value = function (this: any, ...args: any[]) {
      return timeit(`${target.constructor.name}.${property as string}`, () =>
        fn.apply(this, args),
      );
    } as any;
  };
}

export function logflow(s: string) {
  const currentOrder = execStorage.getStore()?.level ?? 0;
  const padding = '  '.repeat(currentOrder);
  logger.log(`${padding}${s}`);
}
