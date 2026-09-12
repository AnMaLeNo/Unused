import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it("unités simples et composées", () => {
    expect(parseDuration("8h")).toBe(8 * 3_600_000);
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("1d12h")).toBe(36 * 3_600_000);
    expect(parseDuration(" 1h 30m ")).toBe(90 * 60_000);
    expect(parseDuration("45s")).toBe(45_000);
  });
  it("refuse ce qui n'est pas une durée", () => {
    for (const bad of ["", "8", "h", "8x", "8h!", "0m", "-1h"]) {
      expect(() => parseDuration(bad), bad).toThrow(/durée invalide/);
    }
  });
});

describe("formatDuration", () => {
  it("lisible", () => {
    expect(formatDuration(8 * 3_600_000 + 5 * 60_000)).toBe("8h05");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(7_000)).toBe("7s");
    expect(formatDuration(-5)).toBe("0s");
  });
});
