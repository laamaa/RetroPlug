import { test, expect } from "../testing/harness";
import { bootSession } from "../cli/session";
import { runRenderJob } from "../src/render";

declare const __REPO_RESOURCES_DIR__: string;
declare const __CONFIG_DIR__: string;

test("NES channel rendering names every VRC7 stem and checks expansion files when avoiding collisions", () => {
  const s = bootSession();
  const base = `${__CONFIG_DIR__}/voice`;
  const occupied = `${base}_vrc7_fm6.wav`;
  expect(s.backend.writeFile(occupied, new Uint8Array([1, 2, 3]))).toBeTruthy();
  try {
    const result = runRenderJob(s, {
      rom: `${__REPO_RESOURCES_DIR__}/roms/bliptoaster-vrc7.nes`, out: base,
      split: "channels", start: false, transport: false, listSongs: false,
      durationMs: 50, maxDurationMs: 50, onExists: "rename",
    }, { log: () => {}, warn: () => {} });
    expect(result.outputs.length).toBe(11);
    expect(result.outputs[5]).toBe(`${base}_2_vrc7_fm1.wav`);
    expect(result.outputs[10]).toBe(`${base}_2_vrc7_fm6.wav`);
    expect(s.backend.readFile(occupied)).toEqual(new Uint8Array([1, 2, 3]));
    for (const path of result.outputs) expect(s.backend.readFile(path)!.length).toBeGreaterThan(44);
  } finally {
    for (const v of s.project.systems.view()) s.project.systems.removeSystem(v.id);
  }
});
