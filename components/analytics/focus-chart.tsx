import {
  CHART,
  dateTick,
  plotHeight,
  plotWidth,
  slotCenter,
  tickIndices,
} from "./chart-utils";
import { DataTable, type DataTableColumn } from "./data-table";

type FocusDay = { date: string; focus_minutes: number };

type FocusChartProps = {
  days: readonly FocusDay[];
};

const HEADING = "Focus minutes per day";
const HEADING_ID = "focus-chart-heading";
const TITLE_ID = "focus-chart-title";
const DESC_ID = "focus-chart-desc";

const COLUMNS: DataTableColumn<FocusDay>[] = [
  { key: "date", header: "Date", render: (row) => row.date },
  {
    key: "focus_minutes",
    header: "Focus minutes",
    render: (row) => `${row.focus_minutes}`,
  },
];

/**
 * Daily focus minutes as bars (spec component `focus-chart`). Non-color
 * encoding is bar height; every bar also carries a `<title>` tooltip and an
 * `aria-label`, and the chart ships the required sr-only data table plus a
 * collapsed `<details>` copy for sighted users. All-zero or empty ranges
 * render an honest note instead of a chart of nothing.
 */
export function FocusChart({ days }: FocusChartProps) {
  const values = days.map((day) => day.focus_minutes);
  const hasData = values.some((value) => value > 0);
  const axisMax = hasData ? Math.max(...values) : 0;
  const plotW = plotWidth();
  const plotH = plotHeight();
  const slot = plotW / Math.max(days.length, 1);
  const barWidth = Math.max(slot * 0.68, 1);
  const total = values.reduce((sum, value) => sum + value, 0);
  const peak = days[values.indexOf(axisMax)];

  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col">
      <h2 id={HEADING_ID} className="mb-2 text-base font-semibold">
        {HEADING}
      </h2>
      {!hasData && (
        <p className="text-sm text-muted-foreground">
          No focus sessions in this range yet.
        </p>
      )}
      {hasData && (
        <>
          <svg
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            role="img"
            aria-labelledby={`${TITLE_ID} ${DESC_ID}`}
            className="w-full"
          >
            <title id={TITLE_ID}>Daily focus minutes</title>
            <desc id={DESC_ID}>
              Bar chart of focus minutes per day from {days[0]?.date} to{" "}
              {days[days.length - 1]?.date}. Peak {axisMax} minutes on{" "}
              {peak?.date}; total {total} minutes across {days.length} days.
              Values are also listed in the data table below.
            </desc>
            <line
              x1={CHART.left}
              x2={CHART.left + plotW}
              y1={CHART.top + plotH}
              y2={CHART.top + plotH}
              className="stroke-muted-foreground"
              strokeWidth={1}
            />
            <text
              x={CHART.left - 6}
              y={CHART.top + 4}
              textAnchor="end"
              fontSize={10}
              className="fill-muted-foreground"
            >
              {axisMax}
            </text>
            <text
              x={CHART.left - 6}
              y={CHART.top + plotH}
              textAnchor="end"
              fontSize={10}
              className="fill-muted-foreground"
            >
              0
            </text>
            {days.map((day, index) => {
              if (day.focus_minutes <= 0) {
                return null;
              }
              const barHeight = (day.focus_minutes / axisMax) * plotH;
              const x =
                CHART.left + index * slot + (slot - barWidth) / 2;
              return (
                <rect
                  key={day.date}
                  x={x}
                  y={CHART.top + plotH - barHeight}
                  width={barWidth}
                  height={barHeight}
                  className="fill-primary"
                  tabIndex={0}
                  aria-label={`${day.date}: ${day.focus_minutes} minutes`}
                >
                  <title>{`${day.date}: ${day.focus_minutes} min`}</title>
                </rect>
              );
            })}
            {tickIndices(days.length).map((index) => (
              <text
                key={index}
                x={slotCenter(index, days.length)}
                y={CHART.height - 8}
                textAnchor="middle"
                fontSize={10}
                className="fill-muted-foreground"
              >
                {dateTick(days[index]?.date ?? "")}
              </text>
            ))}
          </svg>
          <DataTable
            className="sr-only"
            caption="Daily focus minutes (text alternative to the chart)"
            columns={COLUMNS}
            rows={days}
            rowKey={(row) => row.date}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:underline">
              Show focus minutes data table
            </summary>
            <div className="mt-2 overflow-x-auto">
              <DataTable
                caption="Daily focus minutes"
                columns={COLUMNS}
                rows={days}
                rowKey={(row) => row.date}
              />
            </div>
          </details>
        </>
      )}
    </section>
  );
}
