import {
  CHART,
  dateTick,
  percentOf,
  plotHeight,
  plotWidth,
  slotCenter,
  tickIndices,
} from "./chart-utils";
import { DataTable, type DataTableColumn } from "./data-table";

type AccuracyDay = { date: string; quiz_correct: number; quiz_total: number };

type AccuracyChartProps = {
  days: readonly AccuracyDay[];
};

const HEADING = "Daily quiz accuracy";
const HEADING_ID = "accuracy-chart-heading";
const TITLE_ID = "accuracy-chart-title";
const DESC_ID = "accuracy-chart-desc";

type TableRow = AccuracyDay & { accuracy: number | null };

const COLUMNS: DataTableColumn<TableRow>[] = [
  { key: "date", header: "Date", render: (row) => row.date },
  { key: "correct", header: "Correct", render: (row) => `${row.quiz_correct}` },
  { key: "total", header: "Attempted", render: (row) => `${row.quiz_total}` },
  {
    key: "accuracy",
    header: "Accuracy",
    render: (row) =>
      row.accuracy === null ? "—" : `${percentOf(row.accuracy)}%`,
  },
];

function accuracyOf(day: AccuracyDay): number | null {
  return day.quiz_total > 0 ? day.quiz_correct / day.quiz_total : null;
}

/**
 * Quiz accuracy per day as a line (spec component `accuracy-chart`). Days
 * with no attempts have `null` accuracy and break the line — the axis is not
 * a daily-0% line; every point carries a `<title>` tooltip and an
 * `aria-label`. Charts with no attempts render an honest note instead.
 */
export function AccuracyChart({ days }: AccuracyChartProps) {
  const rows: TableRow[] = days.map((day) => ({
    ...day,
    accuracy: accuracyOf(day),
  }));
  const points = rows
    .map((row, index) =>
      row.accuracy === null
        ? null
        : { index, row, accuracy: row.accuracy },
    )
    .filter((point): point is { index: number; row: TableRow; accuracy: number } =>
      point !== null,
    );
  const hasData = points.length > 0;
  const plotH = plotHeight();
  const yOf = (accuracy: number) => CHART.top + plotH * (1 - accuracy);
  const peak = hasData
    ? points.reduce((best, point) =>
        point.accuracy > best.accuracy ? point : best,
      )
    : null;

  // Split the series on null days so the line never spans a gap.
  const segments: { from: number; to: number }[] = [];
  let runStart: number | null = null;
  rows.forEach((row, index) => {
    if (row.accuracy !== null && runStart === null) {
      runStart = index;
    }
    if (row.accuracy === null && runStart !== null) {
      segments.push({ from: runStart, to: index - 1 });
      runStart = null;
    }
  });
  if (runStart !== null) {
    segments.push({ from: runStart, to: rows.length - 1 });
  }

  return (
    <section aria-labelledby={HEADING_ID} className="flex flex-col">
      <h2 id={HEADING_ID} className="mb-2 text-base font-semibold">
        {HEADING}
      </h2>
      {!hasData && (
        <p className="text-sm text-muted-foreground">
          No quiz attempts in this range yet.
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
            <title id={TITLE_ID}>Daily quiz accuracy</title>
            <desc id={DESC_ID}>
              Line chart of quiz accuracy (correct answers ÷ attempted) from{" "}
              {rows[0]?.date} to {rows[rows.length - 1]?.date} on days with
              attempts. Peak {percentOf(peak?.accuracy ?? 0)}% on{" "}
              {peak?.row.date}. Days without attempts are shown as gaps and
              listed as “—” in the data table below.
            </desc>
            <line
              x1={CHART.left}
              x2={CHART.left + plotWidth()}
              y1={CHART.top}
              y2={CHART.top}
              className="stroke-muted-foreground"
              strokeWidth={1}
            />
            <line
              x1={CHART.left}
              x2={CHART.left + plotWidth()}
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
              100%
            </text>
            <text
              x={CHART.left - 6}
              y={CHART.top + plotH}
              textAnchor="end"
              fontSize={10}
              className="fill-muted-foreground"
            >
              0%
            </text>
            {segments.map(({ from, to }) => (
              <polyline
                key={`${from}-${to}`}
                points={rows
                  .slice(from, to + 1)
                  .map(
                    (row, offset) =>
                      `${slotCenter(from + offset, rows.length)},${yOf(row.accuracy ?? 0)}`,
                  )
                  .join(" ")}
                fill="none"
                className="stroke-primary"
                strokeWidth={2}
              />
            ))}
            {points.map(({ index, row, accuracy }) => (
              <g key={row.date}>
                <circle
                  cx={slotCenter(index, rows.length)}
                  cy={yOf(accuracy)}
                  r={3.5}
                  className="fill-primary"
                  tabIndex={0}
                  aria-label={`${row.date}: ${percentOf(accuracy)}% (${row.quiz_correct} of ${row.quiz_total} correct)`}
                >
                  <title>{`${row.date}: ${percentOf(accuracy)}% (${row.quiz_correct}/${row.quiz_total})`}</title>
                </circle>
              </g>
            ))}
            {tickIndices(rows.length).map((index) => (
              <text
                key={index}
                x={slotCenter(index, rows.length)}
                y={CHART.height - 8}
                textAnchor="middle"
                fontSize={10}
                className="fill-muted-foreground"
              >
                {dateTick(rows[index]?.date ?? "")}
              </text>
            ))}
          </svg>
          <DataTable
            className="sr-only"
            caption="Daily quiz accuracy (text alternative to the chart)"
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => row.date}
          />
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:underline">
              Show quiz accuracy data table
            </summary>
            <div className="mt-2 overflow-x-auto">
              <DataTable
                caption="Daily quiz accuracy"
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => row.date}
              />
            </div>
          </details>
        </>
      )}
    </section>
  );
}
