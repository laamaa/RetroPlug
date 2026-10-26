// Register-driven synthetic carts exercise every hardware voice independently of a music ROM's
// channel allocation (BlipToaster uses fewer than eight N163 voices and doesn't synthesize MMC5 PCM).
import { test, expect } from "../testing/harness";
import { bootSession } from "../cli/session";
import { syncDspFromStore } from "../src/appHost";
import { rms } from "./audio-levels-lib";

declare const __CONFIG_DIR__: string;

function cart(mapper: number) {
  const s = bootSession();
  const rom = new Uint8Array(16 + 32768);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 0, (mapper & 15) << 4, mapper & 0xf0]);
  for (let bank = 0; bank < 4; bank++) {
    rom.set([0x78, 0x4c, 0x01, 0xe0], 16 + bank * 8192); // SEI; JMP $E001
    rom.set([0, 0xe0], 16 + bank * 8192 + 0x1ffc);
  }
  const path = `${__CONFIG_DIR__}/mapper-${mapper}.nes`;
  expect(s.backend.writeFile(path, rom)).toBeTruthy();
  s.project.systems.adopt({ romPath: path, roles: [{ kind: "mesen", config: { channelExportMode: "individualMono" } }] });
  syncDspFromStore(s.project, s.dsp);
  const id = s.project.systems.view()[0].id;
  s.audio.renderAudio(100);
  // Debug writes intentionally suppress mapper/APU side effects. Execute a real LDA/STA from
  // internal RAM instead, then return to the fixture's idle loop.
  const write = (addr: number, value: number) => {
    const code = [0xa9, value, 0x8d, addr & 255, addr >> 8, 0x4c, 0x01, 0xe0];
    code.forEach((b, i) => expect(s.backend.writeCpu(id, 0x200 + i, b)).toBeTruthy());
    expect(s.backend.setCpuRegister(id, "pc", 0x200)).toBeTruthy();
    expect(s.backend.runUntilPc(id, 0xe001, 1000)).toBeTruthy();
  };
  const isolate = (voice: number, count: number) => {
    s.audio.renderAudio(80); // flush register edges and the preceding voice's highpass tail
    const levels = s.audio.renderAudioPerChannel(id, 80).map(rms);
    console.log(`[mapper ${mapper} voice ${voice + 1}] ${JSON.stringify(levels)}`);
    expect(levels.length).toBe(5 + count);
    expect(levels[5 + voice]).toBeGreaterThan(0.0001);
    // FM key-off releases naturally, and maximum attenuation isn't a hard mute. Keep its
    // residual at least 40 dB below the selected voice; digital pulse/wave stems must be silent.
    const quiet = mapper === 85 ? levels[5 + voice] * 0.01 : 0.00001;
    levels.forEach((v, i) => { if (i !== 5 + voice) expect(v).toBeLessThan(quiet); });
  };
  return { s, id, write, isolate, close: () => s.project.systems.removeSystem(id) };
}

test("VRC6: both pulses and saw reach their own stems", () => {
  const c = cart(24);
  try {
    for (let voice = 0; voice < 3; voice++) {
      for (const base of [0x9000, 0xa000, 0xb000]) c.write(base + 2, 0);
      const base = [0x9000, 0xa000, 0xb000][voice];
      c.write(base, voice === 2 ? 32 : 0x3f);
      c.write(base + 1, 0x80);
      c.write(base + 2, 0x81);
      c.isolate(voice, 3);
    }
  } finally { c.close(); }
});

test("VRC7: all six FM voices reach distinct stems", () => {
  const c = cart(85);
  const reg = (r: number, value: number) => { c.write(0x9010, r); c.write(0x9030, value); };
  try {
    for (let voice = 0; voice < 6; voice++) {
      for (let ch = 0; ch < 6; ch++) {
        reg(0x30 + ch, 0x10 | (ch === voice ? 0 : 15));
        reg(0x10 + ch, 0x80);
        reg(0x20 + ch, ch === voice ? 0x19 : 0);
      }
      c.isolate(voice, 6);
    }
  } finally { c.close(); }
});

test("N163: all eight fixed stems isolate voices and clock-disable settles to silence", () => {
  const c = cart(19);
  const ram = (addr: number, value: number) => { c.write(0xf800, addr); c.write(0x4800, value); };
  try {
    for (let i = 0; i < 16; i++) ram(i, (i & 15) | ((15 - i) << 4));
    for (let ch = 0; ch < 8; ch++) {
      const base = 0x40 + ch * 8;
      ram(base, 0xff); ram(base + 2, 0xff); ram(base + 4, 0xe1); ram(base + 6, 0);
    }
    for (let voice = 0; voice < 8; voice++) {
      for (let ch = 0; ch < 8; ch++) ram(0x47 + ch * 8, (ch === 7 ? 0x70 : 0) | (ch === 7 - voice ? 15 : 0));
      c.isolate(voice, 8);
    }
    c.write(0xe000, 0x40);
    // Clock-disable holds the last DAC level, as on the mixed path; the highpass tail decays.
    c.s.audio.renderAudio(100);
    expect(Math.max(...c.s.audio.renderAudioPerChannel(c.id, 80).map(rms))).toBeLessThan(0.00001);
  } finally { c.close(); }
});

test("MMC5: both pulse stems and the PCM DAC are independent", () => {
  const c = cart(5);
  try {
    for (let voice = 0; voice < 2; voice++) {
      c.write(0x5015, 1 << voice);
      const base = 0x5000 + voice * 4;
      c.write(base, 0x3f); c.write(base + 2, 0x80); c.write(base + 3, 0x08);
      c.isolate(voice, 3);
    }
    c.write(0x5015, 0);
    c.s.audio.renderAudio(100);
    c.write(0x5010, 0); c.write(0x5011, 64);
    const levels = c.s.audio.renderAudioPerChannel(c.id, 10).map(rms);
    expect(levels[7], "PCM DAC edge reaches output 8").toBeGreaterThan(0.001);
    levels.slice(0, 7).forEach((v) => expect(v).toBeLessThan(0.00001));
  } finally { c.close(); }
});

test("S5B: each tone generator reaches its own stem", () => {
  const c = cart(69);
  const reg = (r: number, value: number) => { c.write(0xc000, r); c.write(0xe000, value); };
  try {
    reg(7, 0x38); // tones enabled; noise disabled
    for (let voice = 0; voice < 3; voice++) {
      for (let ch = 0; ch < 3; ch++) { reg(ch * 2, 0x80); reg(ch * 2 + 1, 0); reg(8 + ch, ch === voice ? 15 : 0); }
      c.isolate(voice, 3);
    }
  } finally { c.close(); }
});
