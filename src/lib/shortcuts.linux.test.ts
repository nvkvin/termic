// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  bindingFromEvent, bindingMatches, eventKeyToken, isTabKey, setSuperHeldForTests, superIsHeld,
} from "./shortcuts";
import { IS_LINUX } from "./platform";

// Its own file because it needs a DOM, and a DOM is what makes platform.ts
// answer "Linux": shortcuts.test.ts runs under node, which reads as macOS.

it("runs as Linux", () => {
  expect(IS_LINUX).toBe(true);
});

// The unit-test DOM reports Linux (see platform.ts), which is the platform
// these are about. The shapes below are what WebKitGTK delivered for real X
// key events, measured: Super never shows up as a modifier on the letter.
describe("Super on Linux", () => {
  const press = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  const j = () => ({
    key: "j", code: "KeyJ", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    getModifierState: () => false,
  }) as unknown as KeyboardEvent;
  const cmdJ = { key: "j", cmd: true, shift: false, alt: false };

  it("counts as Cmd while it is held, from its own keydown and keyup", () => {
    expect(bindingMatches(j(), cmdJ)).toBe(false);
    press("keydown", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(true);
    expect(bindingMatches(j(), cmdJ)).toBe(true);
    press("keyup", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(false);
    // The same event is a typed j again.
    expect(bindingMatches(j(), cmdJ)).toBe(false);
  });

  it("lets go when the window loses focus, since the keyup can go with it", () => {
    press("keydown", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(superIsHeld()).toBe(false);
  });

  it("does not turn a bare-key binding into a Super one", () => {
    setSuperHeldForTests(true);
    try {
      const f12 = { key: "F12", cmd: false, shift: false, alt: false };
      const e = { ...j(), key: "F12", code: "F12" } as unknown as KeyboardEvent;
      expect(bindingMatches(e, f12)).toBe(false);
    } finally { setSuperHeldForTests(false); }
  });

  it("records a chord pressed with Super as a Cmd binding, and never Super alone", () => {
    setSuperHeldForTests(true);
    try {
      expect(bindingFromEvent(j())).toEqual(cmdJ);
      const superKey = { ...j(), key: "Super", code: "OSLeft" } as unknown as KeyboardEvent;
      expect(bindingFromEvent(superKey)).toBeNull();
    } finally { setSuperHeldForTests(false); }
  });
});

describe("Shift+Tab on Linux", () => {
  // X gives Shift+Tab the keysym ISO_Left_Tab; WebKitGTK reports it so.
  const shiftTab = { key: "Unidentified", code: "Tab", ctrlKey: true, shiftKey: true } as unknown as KeyboardEvent;
  it("is still Tab", () => {
    expect(isTabKey(shiftTab)).toBe(true);
    expect(eventKeyToken(shiftTab)).toBe("Tab");
    expect(isTabKey({ key: "Tab", code: "Tab" } as unknown as KeyboardEvent)).toBe(true);
    expect(isTabKey({ key: "Unidentified", code: "KeyQ" } as unknown as KeyboardEvent)).toBe(false);
  });
});
