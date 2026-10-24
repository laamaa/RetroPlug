import { test, expect } from "../../testing/harness";
import { gridNativeSize, nativeScreenSize, gridContentSize, displayZoom, hitTestTile, integerFrameSize, SystemLayout } from "../../ui/screens/grid/layout";

const nes = nativeScreenSize("nes");

test("NES zoom sizes the window in whole native frames", () => {
  for (let zoom = 1; zoom <= 6; zoom++) {
    const size = gridContentSize(1, SystemLayout.Auto, zoom, gridNativeSize([{ platform: "nes" }]));
    expect(size.width).toBe(256 * zoom);
    expect(size.height).toBe(240 * zoom);
    expect(displayZoom(1, SystemLayout.Auto, zoom, 3, size, nes)).toBe(zoom);
  }
});

test("a constrained NES window reduces to a whole zoom and centers hit testing", () => {
  const window = { width: 600, height: 500 };
  expect(displayZoom(1, SystemLayout.Auto, 3, 3, window, nes)).toBe(2);
  // 512×480 centered at (44,10).
  expect(hitTestTile(44, 10, 1, SystemLayout.Auto, 3, 3, window, nes)).toBe(0);
  expect(hitTestTile(555, 489, 1, SystemLayout.Auto, 3, 3, window, nes)).toBe(0);
  expect(hitTestTile(43, 10, 1, SystemLayout.Auto, 3, 3, window, nes)).toBe(null);
  expect(hitTestTile(556, 10, 1, SystemLayout.Auto, 3, 3, window, nes)).toBe(null);
});

test("mixed consoles fit whole pixels inside shared cells", () => {
  const base = gridNativeSize([{ platform: "gb" }, { platform: "nes" }]);
  expect(base).toEqual({ width: 256, height: 240 });
  const size = gridContentSize(2, SystemLayout.Row, 3, base);
  expect(size.width).toBe(1536);
  expect(size.height).toBe(720);
  expect(integerFrameSize(nativeScreenSize("gb"), { width: 768, height: 720 })).toEqual({ width: 640, height: 576 });
  expect(integerFrameSize(nes, { width: 768, height: 720 })).toEqual({ width: 768, height: 720 });
  expect(hitTestTile(800, 100, 2, SystemLayout.Row, 3, 3, size, base)).toBe(1);
});

test("other consoles use native dimensions and empty projects keep GB sizing", () => {
  expect(gridNativeSize([])).toEqual({ width: 160, height: 144 });
  expect(nativeScreenSize("gba")).toEqual({ width: 240, height: 160 });
  expect(nativeScreenSize("sms")).toEqual({ width: 256, height: 192 });
  expect(nativeScreenSize("gg")).toEqual({ width: 160, height: 144 });
});
