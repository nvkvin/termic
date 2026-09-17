import { describe, expect, it } from "vitest";
import { clampUsagesSize, USAGES_MIN_HEIGHT, USAGES_MIN_WIDTH } from "./usagesPopup";

describe("clampUsagesSize", () => {
  const room = { width: 1000, height: 600 };

  it("keeps a size that fits", () => {
    expect(clampUsagesSize({ width: 800, height: 500 }, room)).toEqual({ width: 800, height: 500 });
  });

  it("stops at the window edge", () => {
    expect(clampUsagesSize({ width: 1400, height: 900 }, room)).toEqual(room);
  });

  it("never drags smaller than the minimum", () => {
    expect(clampUsagesSize({ width: 10, height: -40 }, room))
      .toEqual({ width: USAGES_MIN_WIDTH, height: USAGES_MIN_HEIGHT });
  });

  it("prefers the minimum when the window has less room than that", () => {
    // A popup opened near the bottom-right corner: shrinking it to nothing
    // would lose the list, so the minimum wins and it overflows instead.
    expect(clampUsagesSize({ width: 500, height: 300 }, { width: 100, height: 50 }))
      .toEqual({ width: USAGES_MIN_WIDTH, height: USAGES_MIN_HEIGHT });
  });

  it("rounds to whole pixels", () => {
    expect(clampUsagesSize({ width: 400.6, height: 200.2 }, room)).toEqual({ width: 401, height: 200 });
  });
});
