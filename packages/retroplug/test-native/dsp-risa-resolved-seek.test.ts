// Differential oracle: the host model must place the ROM in the same complete
// TRANSPORT state as uninterrupted external-clock playback, then keep advancing.
import { test, expect, skip } from "../testing/harness";
import { createRealBackend } from "../src/realBackend";
import { createAudioDriver } from "../src/audioDriver";
import { createDspRuntime } from "../src/dspRuntime";
import { risaReadyStatus } from "../src/risa/romDetect";
import { initWorkingDefaults } from "../src/risa/codec/working";
import { buildRisaSeekTimeline, locateRisaClock, risaResolvedArm } from "../src/risa/seek";

declare const __RISA_SRC__: string;
declare const __DSP_KERNEL_BUNDLE__: string;
const DATA = 0x2000;
function fixture(kind: string): Uint8Array {
  const w = initWorkingDefaults();
  w.set([0x4e, 0x38, 0x54, 0x0c], DATA + 0x1e80);
  // Distinct row notes make an incorrect sounding-row prime visible too.
  for (let t = 0; t < 5; t++) {
    for (let r = 0; r < 3; r++) w[DATA + 0x1000 + t * 128 + r] = t;
    for (let r = 0; r < t + 1; r++) w[DATA + t * 32 + r * 2] = t;
    for (let r = 0; r < 16; r++) w.set([40 + r, 0, 0, 0], t * 64 + r * 4);
  }
  if (kind === "grooves") {
    w.set([3, 3, 8, 5], DATA + 0x1580);
    w.set([2, 9, 2], DATA + 0x1580 + 17);
    w.set([40, 0, 7, 1], 2 * 64 + 7 * 4);
  }
  if (kind === "hops") {
    w.set([255, 255, 8, 0], 4 * 4);
    w.set([255, 255, 8, 0x23], 64 + 5 * 4);
    w.set([255, 255, 8, 0x10], 2 * 64 + 2 * 4);
    w.set([255, 255, 8, 255], 3 * 64 + 8 * 4);
    w[DATA + 0x1000 + 4 * 128 + 1] = 255; // independent single-row island
  }
  if (kind === "high-phrases") {
    for (let r = 0; r < 3; r++) w[DATA + 2 * 32 + r * 2] = 0x80;
    for (let r = 0; r < 16; r++) w.set([50 + r, 0, 0, 0], 0x6000 + r * 4);
    w.set([255, 255, 7, 1], 0x6000 + 5 * 4);
    w.set([2, 3, 7], DATA + 0x1580 + 17);
  }
  return w;
}

test("native seek worker reads live song edits without an editor or projection timer", () => {
  const be = createRealBackend();
  const audio = createAudioDriver();
  const dsp = createDspRuntime();
  const id = 1;
  be.removeSystem(id);
  const rom = `${__RISA_SRC__}/build/risa-pal.nes`;
  const labelPath = `${__RISA_SRC__}/build/risa-pal.lbl`;
  if (!be.fileExists(rom) || !be.fileExists(labelPath)) skip("build current Risa ROM first");
  const labels = new TextDecoder().decode(be.readFile(labelPath)!);
  const addr = (name: string): number => {
    const match = labels.match(new RegExp(`^al ([0-9A-Fa-f]+) \\.${name}$`, "m"));
    if (!match) throw new Error(`Missing ${name}`);
    return parseInt(match[1], 16);
  };
  const battery = new Uint8Array(65536);
  battery.set(fixture("chains"));
  expect(be.constructSystem({ romPath: rom, platform: "nes", core: "mesen", embeddedRom: "",
    savPath: null, statePath: null, sramBytes: battery }, id)).toBe(true);
  audio.renderAudio(2500);
  // Hold the musical clock while the emulated CPU runs. This isolates worker
  // preparation/priming from clock service jitter and allows exact row checks.
  const wrapper = `
    const originalBlock = globalThis.processBlock;
    const originalSystems = globalThis.setSystems;
    let clock = 0, playing = false;
    globalThis.setSystems = (json) => {
      const input = JSON.parse(json);
      clock = input.testClock;
      playing = input.testPlaying;
      originalSystems(json);
    };
    globalThis.processBlock = (input) => {
      input.frames = 0; input.ppqStart = clock / 24; input.transport = playing;
      originalBlock(input);
    };`;
  expect(dsp.loadKernel(dsp.compileScript(__DSP_KERNEL_BUNDLE__ + wrapper)!)).toBe(true);
  const control = (clock: number, playing = true): void => {
    expect(dsp.setSystems({ systems: [{ id, pipeline: [{ kind: "risa-sync", config: { resolvedSeek: true } }] }],
      testClock: clock, testPlaying: playing } as Parameters<typeof dsp.setSystems>[0])).toBe(true);
  };
  const read = (name: string, track = 0): number => be.readRam(id)![addr(name) + track];
  const seek = (clock: number): void => {
    const generation = read("_host_sync_generation");
    control(clock);
    for (let n = 0; n < 200; n++) {
      audio.renderAudio(10);
      if (read("_host_sync_generation") !== generation && read("_host_sync_ready")) return;
    }
    throw new Error("native seek worker did not complete");
  };
  seek(192);
  expect(read("_bss_song_row", 0)).toBe(2); // one phrase per song row
  expect(read("_bss_song_row", 1)).toBe(1); // two phrases per song row
  expect(read("_bss_chain_row", 4)).toBe(2); // five phrases per song row
  seek(0);
  expect(read("_bss_song_row", 0)).toBe(0);
  // Edit the live cartridge, not its seed .sav or the role's config. Next
  // locate must discard the previous timeline and see chain 4's five phrases.
  control(0, false);
  audio.renderAudio(50);
  const bank = read("_bank_shadow");
  expect(be.writeCpu(id, 0x5113, 1)).toBe(true);
  expect(be.writeCpu(id, 0x7000, 4)).toBe(true);
  expect(be.writeCpu(id, 0x5113, bank)).toBe(true);
  seek(192);
  expect(read("_bss_song_row", 0)).toBe(0);
  expect(read("_bss_chain_row", 0)).toBe(2);
  be.removeSystem(id);
});

test("resolved worker seeks and rewinds remain on the live DAW clock at 120 and 295 BPM", () => {
  const be = createRealBackend();
  const audio = createAudioDriver();
  const dsp = createDspRuntime();
  const id = 1;
  be.removeSystem(id);
  const rom = `${__RISA_SRC__}/build/risa-pal.nes`;
  const labelPath = `${__RISA_SRC__}/build/risa-pal.lbl`;
  if (!be.fileExists(rom) || !be.fileExists(labelPath)) skip("build current Risa ROM first");
  const labels = new TextDecoder().decode(be.readFile(labelPath)!);
  const addr = (name: string): number => parseInt(labels.match(new RegExp(`^al ([0-9A-Fa-f]+) \\.${name}$`, "m"))![1], 16);
  const battery = new Uint8Array(65536);
  battery.set(fixture("chains"));
  expect(be.constructSystem({ romPath: rom, platform: "nes", core: "mesen", embeddedRom: "",
    savPath: null, statePath: null, sramBytes: battery }, id)).toBe(true);
  audio.renderAudio(2500);
  expect(dsp.loadKernel(dsp.compileScript(__DSP_KERNEL_BUNDLE__)!)).toBe(true);
  expect(dsp.setSystems({ systems: [{ id, pipeline: [{ kind: "risa-sync", config: { resolvedSeek: true } }] }] })).toBe(true);
  for (const bpm of [120, 295]) {
    audio.setTransport(false);
    audio.renderAudio(100);
    audio.setBpm(bpm);
    for (const clock of [192, 0, 96]) {
      audio.setPpq(clock / 24);
      audio.setTransport(true);
      audio.renderAudio(1000);
      const ram = be.readRam(id)!;
      // Track zero has one phrase/chain and three song rows (288 clocks).
      const got = ram[addr("_bss_song_last_row")] * 96 + ram[addr("_bss_phrase_last_row")] * 6 +
        (6 - ram[addr("_zp_frame_ctr")]);
      const want = (clock + bpm * 0.4 - 1) % 288;
      console.log(`[resolved clock] bpm=${bpm} seek=${clock} want=${want} got=${got}`);
      expect(Math.abs(got - want) <= 1).toBe(true); // safe-subframe service quantization
    }
  }
  audio.setTransport(false);
  audio.renderAudio(50);
  be.removeSystem(id);
});

for (const region of ["pal", "ntsc"]) {
  for (const kind of ["chains", "grooves", "hops", "high-phrases"]) {
    test(`resolved Risa seek matches continuous ${region} ${kind}`, () => {
      const be = createRealBackend();
      const audio = createAudioDriver();
      const rom = `${__RISA_SRC__}/build/risa-${region}.nes`;
      const labels = `${__RISA_SRC__}/build/${region === "ntsc" ? "ntsc/" : ""}risa-${region}.lbl`;
      if (!be.fileExists(rom) || !be.fileExists(labels)) skip("build current Risa ROMs first");
      const text = new TextDecoder().decode(be.readFile(labels)!);
      const addr = (name: string): number => {
        const m = text.match(new RegExp(`^al ([0-9A-Fa-f]+) \\.${name}$`, "m"));
        if (!m) throw new Error(`Missing ${name}`);
        return parseInt(m[1], 16);
      };
      const id = 1;
      be.removeSystem(id);
      const w = fixture(kind);
      const battery = new Uint8Array(65536);
      battery.set(w);
      expect(be.constructSystem({ romPath: rom, platform: "nes", core: "mesen", embeddedRom: "",
        savPath: null, statePath: null, sramBytes: battery }, id)).toBe(true);
      audio.renderAudio(2500);
      const read = (name: string): number => be.readRam(id)![addr(name)];
      const send = (bytes: number[]): void => { expect(be.stageSystemMidi(id, bytes)).toBe(true); };
      const start = (clock: number): void => {
        send([...risaResolvedArm(locateRisaClock(model, clock)), 0xfa]);
        for (let n = 0; n < 40; n++) {
          audio.renderAudio(10);
          if (read("_host_sync_ready")) return;
        }
        throw new Error("Risa did not prime resolved seek");
      };
      const state = (): number[] => {
        const ram = be.readRam(id)!;
        const out = [ram[addr("_seq_active")], ram[addr("_seq_mode")]];
        for (let t = 0; t < 5; t++) {
          if (!(out[0] & (1 << t))) continue;
          for (const name of ["_bss_song_row", "_bss_chain_row", "_bss_chain_idx", "_bss_phrase_idx",
            "_zp_phrase_row", "_zp_frame_ctr", "_zp_groove_idx", "_zp_groove_pos", "_bss_hop_remaining",
            "_bss_phrase_last_row", "_bss_phrase_last_idx", "_bss_song_last_row"])
            out.push(ram[addr(name) + t]);
        }
        return out;
      };
      const tick = (): void => { send([0xf8]); audio.renderAudio(25); };
      const model = buildRisaSeekTimeline(w);
      const targets = [0, 1, 5, 6, 23, 24, 47, 48, 95, 96, 191, 192, 287, 288, 400];
      const expected = new Map<number, number[]>();
      start(0);
      let clock = 0;
      for (const target of targets) {
        while (clock < target + 1) {
          if (clock === target) expected.set(target, state());
          tick(); clock++;
        }
        expected.set(target + 0.5, state());
      }
      for (const target of targets.slice().reverse()) {
        send([0xfc]); audio.renderAudio(50);
        start(target);
        expect(state()).toEqual(expected.get(target));
        tick();
        expect(state()).toEqual(expected.get(target + 0.5));
      }
      be.removeSystem(id);
    });
  }
}

for (const region of ["pal", "ntsc"]) {
  test(`prepared ${region} start preserves its first row and compensable clock delay`, () => {
    const be = createRealBackend(), audio = createAudioDriver(), dsp = createDspRuntime();
    const rom = `${__RISA_SRC__}/build/risa-${region}.nes`;
    const labels = `${__RISA_SRC__}/build/${region === "ntsc" ? "ntsc/" : ""}risa-${region}.lbl`;
    if (!be.fileExists(rom) || !be.fileExists(labels)) skip("build current Risa ROMs first");
    const ready = risaReadyStatus(be.readFile(rom)!);
    if (!ready) skip("ROM has no RREADY1 capability");
    const text = new TextDecoder().decode(be.readFile(labels)!);
    const addr = (name: string): number => parseInt(text.match(new RegExp(`^al ([0-9A-Fa-f]+) \\.${name}$`, "m"))![1], 16);
    const id = 1, battery = new Uint8Array(65536);
    battery.set(fixture("chains"));
    be.removeSystem(id); audio.setTransport(false);
    expect(be.constructSystem({romPath:rom, platform:"nes", core:"mesen", embeddedRom:"", savPath:null,
      statePath:null, sramBytes:battery}, id)).toBe(true);
    audio.renderAudio(2500);
    expect(dsp.loadKernel(dsp.compileScript(__DSP_KERNEL_BUNDLE__)!)).toBe(true);
    expect(dsp.setSystems({systems:[{id, pipeline:[{kind:"risa-sync",config:{resolvedSeek:true,...ready}}]}]})).toBe(true);
    for (const bpm of [120,145,295]) {
      audio.setTransport(false); audio.setBpm(bpm); audio.setPpq(192/24);
      audio.renderAudio(500); // stopped warm-up, with no ROM ownership
      expect(be.readRam(id)![addr("_host_sync_owned")]).toBe(0);
      audio.setTransport(true);
      let firstReady = 0;
      for (let ms=1;ms<=1000;ms++) {
        audio.renderAudio(1);
        const ram=be.readRam(id)!;
        if (!firstReady && ram[addr("_host_sync_ready")]) {
          firstReady=ms;
          expect(ms >= 100 && ms <= 130).toBe(true);
          expect(ram[addr("_bss_phrase_last_row")]).toBe(0);
          expect(ram[addr("_bss_base_note")]).toBe(40);
        }
      }
      expect(firstReady>0).toBe(true);
      const ram=be.readRam(id)!;
      const got=ram[addr("_bss_song_last_row")]*96 + ram[addr("_bss_phrase_last_row")]*6 + (6-ram[addr("_zp_frame_ctr")]);
      const want=(192 + bpm*0.36 - 1)%288; // 1 second less 100 ms PDC
      console.log(`[prepared clock] ${region} bpm=${bpm} firstReady=${firstReady} want=${want} got=${got}`);
      expect(Math.abs(got-want)<=2).toBe(true);
    }
    be.removeSystem(id);
  });
}

test("cold Risa construction completes boot before handoff and preserves restored state", () => {
 const be=createRealBackend();const rom=`${__RISA_SRC__}/build/risa-pal.nes`;
 const labelPath=`${__RISA_SRC__}/build/risa-pal.lbl`;
 if(!be.fileExists(rom)||!be.fileExists(labelPath))skip("build current Risa ROM first");
 const text=new TextDecoder().decode(be.readFile(labelPath)!);
 const addr=(name:string):number=>parseInt(text.match(new RegExp(`^al ([0-9A-Fa-f]+) \\.${name}$`,"m"))![1],16);
 const id=1,battery=new Uint8Array(65536);battery.set(fixture("chains"));
 be.removeSystem(id);
 const spec={romPath:rom,platform:"nes" as const,core:"mesen" as const,embeddedRom:"",savPath:null,statePath:null,warmupMs:2500};
 expect(be.constructSystem({...spec,sramBytes:battery},id)).toBe(true);
 expect(be.readRam(id)![addr("_seq_busy")]).toBe(0);
 expect(be.getPpuState(id).frameCount>100).toBe(true);
 const cpu=be.getCpuRegisters(id);
 const state=be.readState(id)!;
 be.removeSystem(id);
 expect(be.constructSystem({...spec,stateBytes:state},id)).toBe(true);
 expect(be.getCpuRegisters(id)).toEqual(cpu); // warm-up must not advance restored snapshots
 be.removeSystem(id);
});
