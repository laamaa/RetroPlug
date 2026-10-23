import { test, expect } from "../../testing/harness";
import { initWorkingDefaults } from "../../src/risa/codec/working";
import { buildRisaSeekTimeline, locateRisaClock, risaResolvedArm, sameRisaSeekSong } from "../../src/risa/seek";

const DATA = 0x2000;
function song(lengths = [2, 3]): Uint8Array {
  const w = initWorkingDefaults();
  w.set([0x4e, 0x38, 0x54, 0x0c], DATA + 0x1e80);
  for (let t = 0; t < lengths.length; t++) {
    for (let r = 0; r < 3; r++) w[DATA + 0x1000 + t * 128 + r] = t;
    for (let r = 0; r < lengths[t]; r++) w[DATA + t * 32 + r * 2] = t;
  }
  return w;
}
test("seek follows short chains and independent track positions", () => {
  const p = locateRisaClock(buildRisaSeekTimeline(song()), 192);
  expect(p[0]?.songRow).toBe(1);
  expect(p[0]?.chainRow).toBe(0);
  expect(p[1]?.songRow).toBe(0);
  expect(p[1]?.chainRow).toBe(2);
  expect(p[2]).toBe(null);
});
test("grooves determine row and sub-row phase, including clock zero", () => {
  const w = song([2]);
  w.set([1, 3], DATA + 0x1580);
  const model = buildRisaSeekTimeline(w);
  expect(locateRisaClock(model, 0)[0]?.countdown).toBe(3);
  expect(locateRisaClock(model, 47)[0]?.phraseRow).toBe(15);
  expect(locateRisaClock(model, 47)[0]?.countdown).toBe(1);
  expect(locateRisaClock(model, 48)[0]?.chainRow).toBe(1);
});
test("H0y skips to the next phrase and HFF stops only its track", () => {
  const w = song();
  w.set([255, 255, 8, 0], 4 * 4);
  w.set([255, 255, 8, 255], 64 + 8 * 4);
  const model = buildRisaSeekTimeline(w);
  // The host resolves H00; the ROM primes its landing note exactly once.
  expect(locateRisaClock(model, 48)[0]?.chainRow).toBe(0);
  expect(locateRisaClock(model, 48)[0]?.songRow).toBe(1);
  expect(locateRisaClock(model, 48)[0]?.phraseRow).toBe(0);
  expect(locateRisaClock(model, 48)[1]).toBe(null);
});
test("counted Hxy revisits rows before exhausting its counter", () => {
  const w = song([1]);
  w.set([255, 255, 8, 0x20], 4);
  const model = buildRisaSeekTimeline(w);
  expect(locateRisaClock(model, 12)[0]?.phraseRow).toBe(0);
  expect(locateRisaClock(model, 12)[0]?.hopRemaining).toBe(0);
  expect(locateRisaClock(model, 24)[0]?.phraseRow).toBe(2);
});
test("loop lookup remains bounded at distant times", () => {
  const model = buildRisaSeekTimeline(song([1]));
  expect(model.tracks[0].events.length).toBe(48);
  expect(locateRisaClock(model, 288 * 1000000 + 12)[0]?.phraseRow).toBe(2);
});
test("song islands wrap rather than skip gaps", () => {
  const w = song([1]);
  w[DATA + 0x1001] = 255;
  const model = buildRisaSeekTimeline(w);
  expect(locateRisaClock(model, 96)[0]?.songRow).toBe(0);
});
test("resolved packets encode individual countdowns and sentinel values", () => {
  const p = locateRisaClock(buildRisaSeekTimeline(song([1])), 5);
  const bytes = risaResolvedArm(p);
  expect(bytes.length).toBe(48);
  expect(bytes.slice(0, 12)).toEqual([0xf9, 0x53, 1, 0, 0, 0, 0, 0, 16, 1, 0, 64]);
  expect(bytes.slice(2).every((b) => b < 128)).toBe(true);
});
test("song comparison ignores runtime scratch and detects phrase edits", () => {
  const w = song();
  const original = w.slice();
  w[DATA + 0x1e40] ^= 1;
  expect(sameRisaSeekSong(original, w)).toBe(true);
  w[2] = 8;
  expect(sameRisaSeekSong(original, w)).toBe(false);
});
