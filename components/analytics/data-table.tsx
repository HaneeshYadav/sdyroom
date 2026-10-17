import type * as React from "react";

import { cn } from "@/lib/utils";

export type DataTableColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
};

type DataTableProps<T> = {
  caption: string;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey?: (row: T) => string;
  className?: string;
};

/**
 * The text fallback every chart ships beside its SVG (PR 16 a11y
 * requirement): a semantic `<table>` with a caption. Charts render it twice —
 * once `sr-only` (always in the accessibility tree for screen-reader users)
 * and once inside a collapsed `<details>` (closed details content is hidden
 * from everyone, so sighted users are not burdened while screen-reader users
 * already have the sr-only copy).
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  className,
}: DataTableProps<T>) {
  return (
    <table className={cn("w-full border-collapse text-left text-xs", className)}>
      <caption className="pb-2 text-left text-sm font-medium text-muted-foreground">
        {caption}
      </caption>
      <thead>
        <tr className="border-b">
          {columns.map((column) => (
            <th key={column.key} scope="col" className="py-1 pr-4 font-medium">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey ? rowKey(row) : index} className="border-b last:border-b-0">
            {columns.map((column) => (
              <td key={column.key} className="py-1 pr-4 tabular-nums">
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
