/**
 * Zero-dependency sliding-window concurrency pool.
 * Eliminates batch-boundary idle time by keeping all slots busy.
 *
 * Chunked (old): [===50 conv===][idle 6s][===50 conv===][idle][===4===]
 * Pool (new):    [==========104 conv continuous, 50 concurrent==========]
 */

/**
 * Execute async tasks with sliding-window concurrency.
 * Unlike chunked batching, a slot is freed the moment a task completes
 * and immediately filled with the next pending task.
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Max parallel executions
 * @param onResult - Optional callback fired when each item completes
 * @returns Results array in same order as input items
 */
export async function concurrentPool<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number,
    onResult?: (result: R, index: number) => void,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]);
            if (onResult) onResult(results[i], i);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(
        Array.from({ length: workerCount }, () => worker()),
    );

    return results;
}
