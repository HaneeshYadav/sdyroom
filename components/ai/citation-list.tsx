/**
 * Citation list under an answer (PR-13, spec §6).
 *
 * Every item is a real, server-produced citation: a link to the resource the
 * chunk came from (`/resources` or `/rooms/{id}` — routes that exist today)
 * with its title and the pages it contributed. The list is the accessible
 * counterpart of the `[n]` markers in the answer text: markers are
 * decorative, these links are the keyboard-reachable path to the source.
 */

import type { StoredCitation } from "@/lib/ai/ask";
import Link from "next/link";

export type CitationListProps = {
  citations: StoredCitation[];
};

export function CitationList({ citations }: CitationListProps) {
  if (citations.length === 0) {
    return null;
  }
  return (
    <div className="mt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sources
      </h3>
      <ol role="list" className="mt-1 flex flex-col gap-1">
        {citations.map((citation) => {
          const pages =
            citation.pages && citation.pages.length > 0
              ? ` (p. ${citation.pages.join(", ")})`
              : "";
          return (
            <li key={`${citation.n}-${citation.resource_id}`}>
              <Link
                href={citation.href}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                [{citation.n}] {citation.title}
                {pages}
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
