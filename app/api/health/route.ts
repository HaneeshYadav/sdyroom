import { NextResponse, type NextRequest } from "next/server";
import { withLogging } from "@/lib/server/with-logging";
import packageJson from "../../../package.json";

/**
 * Liveness: "the process is up and serving". It deliberately never touches
 * the database or storage — a dependency outage must not make a supervisor
 * kill an otherwise healthy app, and readiness (`/api/health/ready`) is the
 * endpoint that answers the dependency question.
 */
async function GET_raw(request: NextRequest): Promise<NextResponse> {
  void request;
  return NextResponse.json(
    {
      status: "ok",
      version: packageJson.version,
      uptime_s: Math.round(process.uptime()),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withLogging(GET_raw);
