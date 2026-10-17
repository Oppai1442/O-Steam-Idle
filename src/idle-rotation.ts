/**
 * Compute Steam idle batches as a circular sequence.
 *
 * Priority AppIDs occupy a fixed slot in every batch. All other AppIDs use
 * the remaining slots. When the last group is short, it wraps to the start
 * of the non-priority list rather than idling fewer games.
 */
export function planCircularIdleBatches(
  appids: readonly number[],
  priorityAppIds: readonly number[],
  maxConcurrent: number
) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }
  const desired = [...new Set(appids.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const desiredSet = new Set(desired);
  const priority = [...new Set(priorityAppIds)]
    .filter(appid => desiredSet.has(appid))
    .slice(0, maxConcurrent);
  const pinned = new Set(priority);
  const rotating = desired.filter(appid => !pinned.has(appid));
  const rotatingSlots = maxConcurrent - priority.length;
  const batches: number[][] = [];

  if (!rotating.length || rotatingSlots === 0) {
    batches.push(priority.slice());
  } else if (rotating.length <= rotatingSlots) {
    batches.push([...priority, ...rotating]);
  } else {
    const batchCount = Math.ceil(rotating.length / rotatingSlots);
    for (let i = 0; i < batchCount; i++) {
      const offset = (i * rotatingSlots) % rotating.length;
      const circularGroup = Array.from(
        { length: rotatingSlots },
        (_, j) => rotating[(offset + j) % rotating.length]
      );
      batches.push([...priority, ...circularGroup]);
    }
  }

  return { desired, priority, rotating, rotatingSlots, batches };
}
