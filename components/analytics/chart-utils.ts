/** Shared geometry for the PR 16 SVG charts (viewBox units). */
export const CHART = {
  width: 720,
  height: 220,
  left: 44,
  right: 8,
  top: 16,
  bottom: 28,
} as const;

export function plotWidth(): number {
  return CHART.width - CHART.left - CHART.right;
}

export function plotHeight(): number {
  return CHART.height - CHART.top - CHART.bottom;
}

/** Center x of the i-th slot in a n-slot plot. */
export function slotCenter(index: number, count: number): number {
  const slot = plotWidth() / Math.max(count, 1);
  return CHART.left + (index + 0.5) * slot;
}

/** "MM-DD" tick label for a UTC yyyy-mm-dd date. */
export function dateTick(date: string): string {
  return date.slice(5);
}

/**
 * Which indices get an x-axis tick: all of them up to 7 days, otherwise a
 * stride that keeps the axis readable, always including the first and last.
 */
export function tickIndices(count: number, maxLabels = 7): number[] {
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const stride = Math.ceil(count / maxLabels);
  const ticks = new Set<number>();
  for (let index = 0; index < count; index += stride) {
    ticks.add(index);
  }
  ticks.add(count - 1);
  return [...ticks].sort((a, b) => a - b);
}

/** Rounds a fraction (0..1) to a whole percentage point. */
export function percentOf(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
}
