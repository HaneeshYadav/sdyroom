// @vitest-environment jsdom
import {
  aiHasFailed,
  aiStatusText,
  AiDemoBanner,
  AiStatusChip,
} from "@/components/ai/ai-status";
import type { IngestErrorCode } from "@/lib/ai/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const ERROR_CODES: IngestErrorCode[] = [
  "no_text_layer",
  "extract_failed",
  "extracted_too_large",
  "ingest_failed",
  "ai_quota_exceeded",
  "ai_provider_failed",
];

describe("aiStatusText — the four published labels", () => {
  it("reads Not indexed for an absent row and for pending", () => {
    expect(aiStatusText(null)).toBe("Not indexed");
    expect(aiStatusText({ status: "pending", error_code: null })).toBe(
      "Not indexed",
    );
  });

  it("reads Indexing… (step) through the pipeline", () => {
    expect(aiStatusText({ status: "extracting", error_code: null })).toBe(
      "Indexing… reading",
    );
    expect(aiStatusText({ status: "chunking", error_code: null })).toBe(
      "Indexing… chunking",
    );
    expect(aiStatusText({ status: "embedding", error_code: null })).toBe(
      "Indexing… embedding",
    );
  });

  it("reads Ready for AI once the document is ready", () => {
    expect(aiStatusText({ status: "ready", error_code: null })).toBe(
      "Ready for AI",
    );
  });

  it("explains every stored failure code honestly", () => {
    const reasons: Record<IngestErrorCode, string> = {
      no_text_layer: "no text layer",
      extract_failed: "couldn't read the file",
      extracted_too_large: "extracted text too large",
      ingest_failed: "indexing failed",
      ai_quota_exceeded: "daily AI limit reached",
      ai_provider_failed: "AI service unavailable",
    };
    for (const code of ERROR_CODES) {
      expect(aiStatusText({ status: "failed", error_code: code })).toBe(
        `Failed — ${reasons[code]}`,
      );
    }
  });

  it("never renders a bare Failed for a hand-written failed row", () => {
    expect(aiStatusText({ status: "failed", error_code: null })).toBe(
      "Failed — indexing failed",
    );
  });

  it("lets error_code win over status (a resumable embed failure still reads as failed)", () => {
    expect(
      aiStatusText({ status: "embedding", error_code: "ai_provider_failed" }),
    ).toBe("Failed — AI service unavailable");
  });
});

describe("aiHasFailed", () => {
  it("is true only when a failure code is stored", () => {
    expect(aiHasFailed(null)).toBe(false);
    expect(aiHasFailed({ status: "ready", error_code: null })).toBe(false);
    expect(aiHasFailed({ status: "embedding", error_code: null })).toBe(false);
    expect(
      aiHasFailed({ status: "embedding", error_code: "ai_quota_exceeded" }),
    ).toBe(true);
  });
});

describe("AiStatusChip", () => {
  it("carries the state as readable text inside the badge", () => {
    render(<AiStatusChip ai={null} />);
    expect(screen.getByTestId("ai-status-chip")).toHaveTextContent("Not indexed");
  });

  it("shows the failure reason on a failed row", () => {
    render(
      <AiStatusChip ai={{ status: "failed", error_code: "no_text_layer" }} />,
    );
    expect(screen.getByTestId("ai-status-chip")).toHaveTextContent(
      "Failed — no text layer",
    );
  });

  it("shows progress while indexing", () => {
    render(<AiStatusChip ai={{ status: "embedding", error_code: null }} />);
    expect(screen.getByTestId("ai-status-chip")).toHaveTextContent(
      "Indexing… embedding",
    );
  });

  it("shows ready state", () => {
    render(<AiStatusChip ai={{ status: "ready", error_code: null }} />);
    expect(screen.getByTestId("ai-status-chip")).toHaveTextContent(
      "Ready for AI",
    );
  });
});

describe("AiDemoBanner", () => {
  it("announces the server-supplied copy as a status region", () => {
    render(<AiDemoBanner text="AI is running in demo mode." />);
    const banner = screen.getByTestId("ai-demo-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("AI is running in demo mode.");
  });
});
