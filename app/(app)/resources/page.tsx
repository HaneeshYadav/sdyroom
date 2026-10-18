import { ResourceLibrary } from "@/components/resources/resource-library";
import { fetchResourceQuota } from "@/lib/resources/quota";
import { listResources } from "@/lib/resources/queries";
import { errorFields, logError } from "@/lib/server/log";
import { createClient } from "@/lib/supabase/server";
import { RESOURCE_PAGE_SIZE_DEFAULT } from "@/lib/validation/resources";
import { redirect } from "next/navigation";

export const metadata = {
  title: "My resources · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * The personal library: only the caller's own private files, never anything
 * shared into a room. The listing runs server-side through RLS and the client
 * component takes the result, so the first paint already shows real rows and
 * every later refresh re-enters the same API path.
 */
export default async function ResourcesPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const [page, quota] = await Promise.all([
    listResources(supabase, {
      viewerId,
      scope: "personal",
      q: "",
      subject: null,
      chapter: null,
      limit: RESOURCE_PAGE_SIZE_DEFAULT,
      offset: 0,
    }),
    // Display-only: if the quota numbers cannot be read the library still
    // opens (the upload route and the DB trigger remain the enforcement),
    // so a quota outage never becomes a listing outage.
    fetchResourceQuota(supabase, null).catch((error: unknown) => {
      logError("[resources/page] quota fetch failed:", errorFields(error));
      return null;
    }),
  ]);

  return (
    <ResourceLibrary
      scope={{ kind: "personal" }}
      initialResources={page.resources}
      initialHasMore={page.has_more}
      quota={quota}
      idPrefix="personal"
      heading="My resources"
      description="Private study files only you can open. Share one with a room from that room's workspace."
    />
  );
}
