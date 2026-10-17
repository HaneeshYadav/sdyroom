"use client";

import { usePathname, useRouter } from "next/navigation";

import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
} from "@/lib/validation/analytics";

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

type RangeSwitcherProps = {
  current: AnalyticsRange;
};

/**
 * The 7d/30d/90d switch (spec component `range-switcher`): a native select
 * that replaces `?range=` on the current page with `scroll: false`, so the
 * range survives reload and shares as a URL while the heading and panel copy
 * update without losing the page position.
 */
export function RangeSwitcher({ current }: RangeSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="analytics-range"
        className="text-sm text-muted-foreground"
      >
        Range
      </label>
      <select
        id="analytics-range"
        value={current}
        onChange={(event) => {
          router.replace(`${pathname}?range=${event.target.value}`, {
            scroll: false,
          });
        }}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {ANALYTICS_RANGES.map((range) => (
          <option key={range} value={range}>
            {RANGE_LABELS[range]}
          </option>
        ))}
      </select>
    </div>
  );
}
