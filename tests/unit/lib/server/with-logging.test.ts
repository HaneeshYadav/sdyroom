import { errorResponse } from "@/lib/api/responses";
import { metricsSnapshot, resetMetrics } from "@/lib/server/metrics";
import { withLogging } from "@/lib/server/with-logging";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogs } from "../../helpers/log-capture";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/things", {
    headers: { "x-user-id": "user-42", ...headers },
  });
}

let captured: ReturnType<typeof captureLogs>;

beforeEach(() => {
  resetMetrics();
  captured = captureLogs();
});

afterEach(() => {
  captured.restore();
});

describe("withLogging", () => {
  it("passes the request through and returns the handler's response", async () => {
    const handler = async (request: NextRequest): Promise<Response> => {
      void request;
      return new Response("hi", { status: 201 });
    };
    const wrapped = withLogging(handler);

    const response = await wrapped(request());

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hi");
  });

  it("preserves a well-formed caller x-request-id end to end", async () => {
    const handler = async (request: NextRequest) => {
      void request;
      return errorResponse("nope", "No.", 400);
    };
    const wrapped = withLogging(handler);

    const response = await wrapped(request({ "x-request-id": "caller-id-0001" }));
    const body = await response.json();

    expect(response.headers.get("x-request-id")).toBe("caller-id-0001");
    expect(body.error.request_id).toBe("caller-id-0001");
  });

  it("replaces a malformed caller id and uses the replacement everywhere", async () => {
    const handler = async (request: NextRequest) => {
      void request;
      return errorResponse("nope", "No.", 400);
    };
    const wrapped = withLogging(handler);

    const response = await wrapped(request({ "x-request-id": "bad id!" }));
    const body = await response.json();
    const id = response.headers.get("x-request-id");

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body.error.request_id).toBe(id);
  });

  it("logs one access line with route, method, status, duration and user", async () => {
    const handler = async (request: NextRequest) => {
      void request;
      return new Response(null, { status: 204 });
    };
    const wrapped = withLogging(handler);

    await wrapped(request());

    const access = captured.lines.find((line) => line.event === "request");
    expect(access).toMatchObject({
      level: "info",
      route: "/api/things",
      method: "GET",
      status: 204,
      user_id: "user-42",
    });
    expect(typeof access?.duration_ms).toBe("number");
    expect(access?.request_id).toBeTruthy();
  });

  it("answers an uncaught throw with the internal envelope, never a stack", async () => {
    const handler = async (request: NextRequest): Promise<Response> => {
      void request;
      throw new Error("secret internal detail");
    };
    const wrapped = withLogging(handler);

    const response = await wrapped(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
    expect(body.error.request_id).toBe(response.headers.get("x-request-id"));

    const errorLine = captured.lines.find((line) => line.event === "unhandled_route_error");
    expect(errorLine?.level).toBe("error");
    expect(String(errorLine?.stack)).toContain("secret internal detail");
  });

  it("feeds the metrics window with the normalized route", async () => {
    const handler = async (request: NextRequest) => {
      void request;
      return new Response(null, { status: 200 });
    };
    const wrapped = withLogging(handler);

    await wrapped(
      new NextRequest("http://localhost/api/things", { method: "POST" }),
    );

    const snapshot = metricsSnapshot();
    expect(snapshot.requests["/api/things"]?.count).toBe(1);
    expect(snapshot.window_s).toBe(300);
    expect(snapshot.instance).toBe("single");
  });
});
