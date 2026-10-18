import "@testing-library/jest-dom/vitest";
import { silenceLogs } from "./unit/helpers/log-capture";

// The app emits one JSON log line per request through `lib/server/log`.
// Unit tests run against a silent stream by default; tests that assert on
// logging capture lines explicitly via `captureLogs()`.
silenceLogs();

// jsdom has no layout engine; Radix primitives (RadioGroup, Menu, Popper)
// measure through ResizeObserver and would crash without this stub.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}
