import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import updateColumnNameInFormula from './common/helpers/updateColumnNameInFormula';

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

const logger = new Logger('TIMEIT');
// const logger = { debug: console.log };
// const logger = { debug: (...args: any[]) => {} };
const GLOBAL_SHOULD_TRACE = false;

//  TODO: refactor this so it trails properly to the parent (by like previous callee or something like that)
//  This basically should model the execution tree (and so we can log it more nicely)
interface TraceNode {
  executionId: number;
  traceCount: number; // Traces recorded since root
  caller: string;
  depth: number;
  initialStartTime: number; // Time since initial logging begin
  startTime: number;
  endTime: number | null;
  timeToFinish: number | number;
  children: TraceNode[];
  parent: TraceNode | null;
  root: TraceNode | null;
}
const traceContextStore = new AsyncLocalStorage<TraceNode>();
const shouldTraceStore = new AsyncLocalStorage<boolean>();

export function timeit<TReturn>(
  label: string,
  fn: (() => TReturn) | TReturn | Promise<TReturn>,
): TReturn {
  const shouldTrace = shouldTraceStore.getStore() ?? true;
  if (!shouldTrace || !GLOBAL_SHOULD_TRACE)
    return typeof fn === 'function' ? (fn as Function)() : (fn as any);

  const INDENT = '  ';
  const MERGE_TOLERANCE = 0.2;
  const TABULATION_DISTANCE = 80;

  const parentNode = traceContextStore.getStore();
  const current: TraceNode = {
    executionId: -1,
    traceCount: 0,
    depth: (parentNode?.depth ?? -1) + 1, // -1 to ensure it's zero
    caller: label,
    initialStartTime: parentNode?.initialStartTime ?? performance.now(),
    // Should be relative to initial start time
    startTime: -1,
    endTime: null,
    timeToFinish: null, // latency/duration
    parent: null,
    children: [],
    root: null,
  };

  const isRootNode = !parentNode;
  current.root = parentNode?.root ?? current;
  current.parent = parentNode?.parent ?? current;
  current.executionId = ++current.root!.traceCount;

  if (parentNode) parentNode.children.push(current);

  const indent = INDENT.repeat(current.depth);

  const toSeconds = (n: number) => (n / 1000).toFixed(3);
  const getElapsedTime = () =>
    toSeconds(performance.now() - current.initialStartTime);

  const tabulate = (...strings: string[]) => {
    return strings
      .map((s, index) =>
        index === strings.length - 1 ? s : s.padEnd(TABULATION_DISTANCE),
      )
      .join('');
  };
  const logEnd = () => {
    current.endTime = performance.now() - current.initialStartTime;
    current.timeToFinish = current.endTime - current.startTime;

    const durationInSeconds = toSeconds(current.timeToFinish);

    // logger.debug(
    //   tabulate(
    //     `${indent}(${current.executionId}) ${label} took ${durationInSeconds}s`,
    //     `elapsed:${getElapsedTime()}s`,
    //   ),
    // );

    if (isRootNode) {
      const mergeOverlappingTraces = (node: TraceNode) => {
        const updatedNode = { ...node, children: [] };

        // Merge traces which has similar timestamps
        const availableChild = new Set(node.children);
        for (const child of node.children.toSorted(
          (a, b) => a.startTime - b.startTime,
        )) {
          if (!availableChild.has(child)) continue;
          availableChild.delete(child);

          const initialAvailableSibling = availableChild.size;
          let updatedChild = { ...child };

          const availableSiblings = [...availableChild];
          for (const sibling of availableSiblings) {
            if (
              sibling.caller === updatedChild.caller &&
              sibling.startTime >= updatedChild.startTime - MERGE_TOLERANCE &&
              sibling.startTime <= updatedChild.endTime + MERGE_TOLERANCE
            ) {
              updatedChild.children = [
                ...updatedChild.children,
                ...sibling.children,
              ];
              updatedChild.endTime = Math.max(
                sibling.endTime,
                updatedChild.endTime,
              );
              updatedChild.timeToFinish =
                updatedChild.endTime - updatedChild.startTime;

              availableChild.delete(sibling);
            }
          }

          updatedChild.children.forEach((c) => {
            c.parent = updatedChild;
          });
          updatedChild = mergeOverlappingTraces(updatedChild);
          const finalAvailableSibling = availableChild.size;
          const mergedSibling = initialAvailableSibling - finalAvailableSibling;
          if (mergedSibling > 0)
            updatedChild.caller = `${updatedChild.caller} x${
              mergedSibling + 1
            }`;

          updatedNode.children.push(updatedChild);
        }

        return updatedNode;
      };

      const rootNodeRaw = current;
      const rootNode = mergeOverlappingTraces(rootNodeRaw);
      logger.debug(`Generating report for ${rootNode.caller}`);

      logger.debug('------------------');
      logger.debug('[Report]');
      logger.debug('------------------');

      {
        logger.debug('[[Call Tree]]');
        const logTree = (node: TraceNode) => {
          const indent = INDENT.repeat(node.depth);

          const childrenTTF = node.children.reduce(
            (acc, child) => acc + child.timeToFinish,
            0,
          );

          const childrenContributionToTTF =
            (childrenTTF / node.timeToFinish) * 100;
          const contributionToParentTTF =
            (node.timeToFinish / node.parent.timeToFinish) * 100;
          const contributionToTotalTTF =
            (node.timeToFinish / node.root.timeToFinish) * 100;

          const meta = [
            `${toSeconds(node.startTime)}s - ${toSeconds(node.endTime)}s`,
            `${toSeconds(node.timeToFinish)}s`,
            // `${childrenContributionToTTF.toFixed(2)}%`,
            // `${contributionToParentTTF.toFixed(2)}%`,
            `${contributionToTotalTTF.toFixed(2)}%`,
          ].join(' | ');

          // const i = INDENT.repeat(node.depth);
          const i = INDENT.repeat(0);
          logger.debug(
            tabulate(
              `${indent}(${node.executionId}) ${node.caller}`,
              `${i}${meta}`,
            ),
          );
          for (const item of node.children) logTree(item);
        };
        logTree(rootNode);
      }

      // logger.debug('------------------');

      // const flattenTree = (node: TraceNode, dest: TraceNode[] = []) => {
      //   dest.push(node);
      //   for (const child of node.children) flattenTree(child, dest);
      //   return dest;
      // };
      // const flattenedTree = flattenTree(rootNode);

      // {
      //   logger.debug('[[Timeline]]');

      //   const sorted = flattenedTree.toSorted(
      //     (a, b) => a.startTime - b.startTime,
      //   );
      //   for (const p of sorted)
      //     logger.debug(
      //       tabulate(
      //         `${toSeconds(p.startTime)}s | (${p.executionId}) ${p.caller}`,
      //         `will take ${toSeconds(p.timeToFinish)}s`,
      //       ),
      //     );
      // }

      // logger.debug('------------------');
      /* {
        logger.debug('[[Stats]]');

        const grouped = {} as Record<
          string,
          {
            label: string;
            count: number;
            averageTimeToFinish: number;
            maxTimeToFinish: number;
            totalComputeTime: number;
          }
        >;
        for (const trace of flattenedTree) {
          const stat = grouped[trace.caller] ?? {
            label: trace.caller,
            count: 0,
            averageTimeToFinish: 0,
            maxTimeToFinish: 0,
            totalComputeTime: 0, // NOTE: this doesn't consider concurrency, only assuming if it's called sequentially
          };
          grouped[trace.caller] = stat;

          // Update the average instead od recomputing
          const averageUpdate =
            (trace.timeToFinish - stat.averageTimeToFinish) / (stat.count + 1);
          stat.averageTimeToFinish = stat.averageTimeToFinish + averageUpdate;
          stat.maxTimeToFinish = Math.max(
            stat.maxTimeToFinish,
            trace.timeToFinish,
          );
          stat.totalComputeTime += trace.timeToFinish;
          stat.count++;
        }

        const compiled = Object.values(grouped).toSorted(
          (a, b) => b.totalComputeTime - a.totalComputeTime,
        );
        for (const stat of compiled) {
          logger.debug(stat.label);
          logger.debug(`- callCount: ${stat.count}`);
          logger.debug(
            `- totalExecutionTime: ${toSeconds(stat.totalComputeTime)}`,
          );
          logger.debug(
            `- averageLatency: ${toSeconds(stat.averageTimeToFinish)}`,
          );
          logger.debug(`- maxLatency: ${toSeconds(stat.maxTimeToFinish)}`);
        }
      } */

      logger.debug('================');
      logger.debug('');
    }
  };

  return traceContextStore.run(current, (): any => {
    if (isRootNode) logger.debug('================');
    current.startTime = performance.now() - current.initialStartTime;

    if (isRootNode) logger.debug(`Recording trace for ${current.caller}`);
    // logger.debug(
    //   tabulate(
    //     `${indent}(${current.executionId}) ${label} called`,
    //     `elapsed:${getElapsedTime()}s`,
    //   ),
    // );

    const result = typeof fn === 'function' ? (fn as Function)() : fn;

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
  });
}

export function traceConditional<T>(shouldTrace: boolean, fn: () => T) {
  return shouldTraceStore.run(shouldTrace, fn);
}

export function Time(logArgs?: (...args: any[]) => string): MethodDecorator {
  return (target, property, descriptor) => {
    const fn = descriptor.value as (...args: any[]) => any;
    descriptor.value = function (this: any, ...args: any[]) {
      const defaultLabel =
        (target as Function)?.name ?? target.constructor.name;
      const argString = typeof logArgs === 'function' ? logArgs(...args) : '';

      return timeit(`${defaultLabel}.${property as string}(${argString})`, () =>
        fn.apply(this, args),
      );
    } as any;
  };
}

export function logflow(s: string) {
  const currentTrace = traceContextStore.getStore();
  if (!currentTrace) return;
  const padding = '  '.repeat(currentTrace.depth + 1);
  currentTrace.children.push({
    ...currentTrace,
    caller: s,
    depth: currentTrace.depth + 1,
    children: [],
    startTime: currentTrace.startTime,
    endTime: currentTrace.startTime,
    timeToFinish: 0,
  });
}
