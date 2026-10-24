// The fixed 480×432 harness display must fit a NES at 1×, with all 256×240 pixels intact.
// The actual window request still uses the configured 3× zoom (768×720).
import { test, expect, ui, CompType, isFlat } from "ui-harness";
import { createEmulatorClient } from "../src/realBackend";

test("NES requests native-size zoom and renders every source pixel evenly in a constrained window", () => {
  const calls: Array<[number, number]> = [];
  const globals = globalThis as { __rp_setWindowSize?: (w: number, h: number) => void };
  globals.__rp_setWindowSize = (w, h) => calls.push([w, h]);
  try {
    expect(ui.boot()).toBeTruthy();
    ui.pump(30);
    ui.fileDrop(ui.romDir() + "/bliptoaster.nes", 0, 0);
    ui.advance(500);
    ui.pump(30);

    expect(calls[calls.length - 1]).toEqual([768, 720]);
    const tile = ui.findByTestId("tile-0")!;
    expect(tile != null).toBeTruthy();
    expect(tile.width).toBe(256);
    expect(tile.height).toBe(240);
    const canvas = ui.findFirstByType(CompType.Image)!;
    expect(canvas != null).toBeTruthy();
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(240);
    expect(canvas.x).toBe((480 - 256) / 2);
    expect(canvas.y).toBe((432 - 240) / 2);

    // The first loaded system has id 1 in this isolated process. Compare the real core's BGR pixels
    // with the LVGL snapshot, ignoring only the unused X/alpha byte.
    const frame = createEmulatorClient().getFrame(1)!;
    expect(frame?.published).toBeTruthy();
    expect(frame.width).toBe(256);
    expect(frame.height).toBe(240);
    expect(isFlat(frame)).toBeFalsy();
    const snap = ui.snapshot();
    let mismatches = 0;
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 256; x++) {
        const src = (y * 256 + x) * 4;
        const dst = ((canvas.y + y) * snap.width + canvas.x + x) * 4;
        for (let c = 0; c < 3; c++) if (snap.pixels[dst + c] !== frame.pixels[src + c]) mismatches++;
      }
    }
    expect(mismatches, "rendered NES pixels match the core frame").toBe(0);
    expect(ui.snapshotPng("/tmp/ui-nes-screen.png")).toBeTruthy();
  } finally {
    delete globals.__rp_setWindowSize;
  }
});
