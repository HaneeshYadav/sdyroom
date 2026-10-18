import { errorResponse } from "@/lib/api/responses";
import { runWithRequestContext } from "@/lib/server/request-context";
import { describe, expect, it } from "vitest";

describe("errorResponse request_id", () => {
  it("omits request_id outside a request context (background work, helper tests)", async () => {
    const body = await errorResponse("boom", "It broke.", 500).json();

    expect(body).toEqual({
      error: { code: "boom", message: "It broke." },
    });
  });

  it("attaches the context's id so the envelope matches the logs and header", async () => {
    const body = await runWithRequestContext({ requestId: "ctx-abc-12345" }, () =>
      errorResponse("boom", "It broke.", 500).json(),
    );

    expect(body.error.request_id).toBe("ctx-abc-12345");
  });

  it("keeps issues after request_id when validation fails inside a request", async () => {
    const body = await runWithRequestContext({ requestId: "ctx-xyz-67890" }, () =>
      errorResponse("validation", "Check the fields.", 400, [
        { path: "name", message: "Required." },
      ]).json(),
    );

    expect(body.error).toEqual({
      code: "validation",
      message: "Check the fields.",
      request_id: "ctx-xyz-67890",
      issues: [{ path: "name", message: "Required." }],
    });
  });
});
