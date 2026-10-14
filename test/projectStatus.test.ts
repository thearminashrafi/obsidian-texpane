import { describe, expect, it } from "vitest";
import { formatRelativeTime, inBuildFolder, projectState } from "../src/core/projectStatus";

describe("projectState", () => {
  it("maps queue and result", () => {
    expect(projectState("running", "ok")).toBe("building");
    expect(projectState("queued", undefined)).toBe("building");
    expect(projectState("idle", "ok")).toBe("ok");
    expect(projectState("scheduled", "errors")).toBe("error");
    expect(projectState(undefined, "failed")).toBe("error");
    expect(projectState(undefined, "cancelled")).toBe("none");
    expect(projectState(undefined, undefined)).toBe("none");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000;
  it("formats", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("just now");
    expect(formatRelativeTime(now + 5000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe("2 d ago");
  });
});

describe("inBuildFolder", () => {
  it("matches at any depth", () => {
    expect(inBuildFolder("p/.texpane/build/main.pdf", ".texpane/build")).toBe(true);
    expect(inBuildFolder(".texpane/build/main.pdf", ".texpane/build")).toBe(true);
    expect(inBuildFolder("p/main.tex", ".texpane/build")).toBe(false);
    expect(inBuildFolder("p/xbuild/a.pdf", "build")).toBe(false);
    expect(inBuildFolder("p/build/a.pdf", "./build/")).toBe(true);
    expect(inBuildFolder("p/a.pdf", "")).toBe(false);
  });
});
