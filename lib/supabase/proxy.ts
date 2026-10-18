import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasEnvVars } from "../utils";
import { resolveRequestId } from "../server/request-id";

/**
 * Builds the response that continues the request, carrying two server-set
 * headers downstream:
 *
 * - `x-request-id` — resolved once here (caller-supplied only when
 *   well-formed, otherwise fresh) so logs, error envelopes and the response
 *   echo all agree, even for page requests that never reach a route wrapper.
 * - `x-user-id` — the verified session subject, or absent. This is the *only*
 *   writer of that header: any value supplied by the client is replaced
 *   before the request continues, so `withLogging` can treat it as trusted
 *   for the access-log line. No route authorizes from it; identity always
 *   comes from `getClaims()` inside the handler.
 *
 * Rebuilt after every cookie write so the downstream request sees refreshed
 * session cookies (the Supabase template's "do not cause the browser and
 * server to go out of sync" rule).
 */
function continueWith(
  request: NextRequest,
  requestId: string,
  userId: string | null,
): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  if (userId === null) {
    headers.delete("x-user-id");
  } else {
    headers.set("x-user-id", userId);
  }
  return NextResponse.next({ request: { headers } });
}

export async function updateSession(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  let supabaseResponse = continueWith(request, requestId, null);

  // If the env vars are not set, skip proxy check. You can remove this
  // once you setup the project.
  if (!hasEnvVars) {
    supabaseResponse.headers.set("x-request-id", requestId);
    return supabaseResponse;
  }

  // With Fluid compute, don't put this client in a global environment
  // variable. Always create a new one on each request.
  // Cookies written by a claims refresh are recorded here (not applied to a
  // response yet) because the final continuation can only be built once the
  // verified subject is known — `ResponseCookies` has no `setAll`, and a
  // getAll/set round-trip would silently drop the cookie options.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pendingCookies: { name: string; value: string; options?: any }[] = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          pendingCookies = cookiesToSet;
        },
      },
    },
  );

  // Do not run code between createServerClient and
  // supabase.auth.getClaims(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: If you remove getClaims() and you use server-side rendering
  // with the Supabase client, your users may be randomly logged out.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  // The session is known now. Build the one continuation response that
  // carries both the refreshed cookies and the verified subject.
  const continued = continueWith(request, requestId, user?.sub ?? null);
  for (const { name, value, options } of pendingCookies) {
    continued.cookies.set(name, value, options);
  }
  supabaseResponse = continued;

  // API routes answer their own 401 as JSON; handing a fetch client an HTML
  // redirect would break the documented status contract.
  const isApiRoute = request.nextUrl.pathname.startsWith("/api");

  if (
    request.nextUrl.pathname !== "/" &&
    !user &&
    !isApiRoute &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/auth")
  ) {
    // no user, potentially respond by redirecting the user to the login page
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("x-request-id", requestId);
    return redirect;
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  supabaseResponse.headers.set("x-request-id", requestId);
  return supabaseResponse;
}
