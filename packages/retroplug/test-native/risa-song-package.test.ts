import oracle from "../test/risa/golden/song-package-oracle.json";
import { b64decode } from "../src/base64";
import { test, expect, skip } from "../testing/harness";
import { createRealBackend } from "../src/realBackend";
import { createDspRuntime } from "../src/dspRuntime";
import { createAudioDriver } from "../src/audioDriver";
import { ProjectStore } from "../src/projectStore";
import { RecentStore } from "../src/recentStore";
import { buildAppRegistry, syncDspFromStore } from "../src/appHost";
import { songPackageFixture } from "../test/risa/songPackageFixture";
import { RisaRom } from "../src/risa/rom";
import { makeEmptySave, CURRENT_LAYOUT, recordBytesAt, listSongs, workingSongName } from "../src/risa/codec/sav";
import { encodeSongPackage, decodeSongFile } from "../src/risa/songPackage";
import { remapRecordDmcKits, decodeRecord } from "../src/risa/codec/record";
import { planRisaSongImport } from "../src/risaSongImport";
import { loadSongToWorkingInSav } from "../src/risaSongOps";
import { applyOverridesToRom } from "../src/risaAssetsRole";

declare const __CONFIG_DIR__: string;
declare const __RISA_SRC__: string;
declare const __DSP_KERNEL_BUNDLE__: string;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

test("native ZIP codec round-trips a portable Risa song and its linked kit", () => {
  const be = createRealBackend();
  const f = songPackageFixture();
  const file = encodeSongPackage(f.record, f.rom, be);
  expect(Array.from(file.subarray(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
  const path = __CONFIG_DIR__ + "/portable.risong";
  expect(be.writeFile(path, file)).toBe(true);
  expect(equal(decodeSongFile(file, be).record, f.record)).toBe(true);
  const target = RisaRom.fromBytes(f.rom);
  target.clearKitBank(5);
  const plan = planRisaSongImport({ file, path, effectiveRom: target.bytes(), overrides: [], liveSram: makeEmptySave() }, be);
  expect(plan.addedKits).toBe(1);
  const patched = RisaRom.fromBytes(applyOverridesToRom(target.bytes(), plan.overrides, be));
  expect(equal(patched.getKitBank(plan.overrides[0].slot)!, f.bank)).toBe(true);
  expect(listSongs(plan.savBytes)[0].name).toBe("PORTABLE");
});

test("package imports survive a real Risa boot and project reload with their DPCM kit", () => {
  const be = createRealBackend();
  const romPath = __RISA_SRC__ + "/build/risa-pal.nes";
  const base = be.readFile(romPath);
  if (!base) skip("build current Risa ROM first");
  const f = songPackageFixture();
  const source = RisaRom.fromBytes(base!);
  source.setKit(31, f.bank);
  const file = encodeSongPackage(remapRecordDmcKits(f.record, new Map([[5, 31]])), source.bytes(), be);
  const path = __CONFIG_DIR__ + "/playable.risong";
  expect(be.writeFile(path, file)).toBe(true);
  const plan = planRisaSongImport({ file, path, effectiveRom: base!, overrides: [], liveSram: makeEmptySave() }, be);
  expect(plan.addedKits).toBe(1);
  const kit = plan.overrides[0].slot;
  expect(decodeRecord(recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!).instruments[0]![10]).toBe(kit);
  const loaded = loadSongToWorkingInSav(plan.savBytes, 0)!;
  const savPath = __CONFIG_DIR__ + "/playable.sav";
  expect(be.writeFileAtomic(savPath, loaded)).toBe(true);
  const project = new ProjectStore(be, new RecentStore(be), buildAppRegistry());
  const dsp = createDspRuntime(), audio = createAudioDriver();
  expect(dsp.loadKernel(dsp.compileScript(__DSP_KERNEL_BUNDLE__)!)).toBe(true);
  project.setOnSystemsChange(() => syncDspFromStore(project, dsp));
  const id = project.systems.adopt({ romPath, savPath, roles: [
    { kind: "mesen", config: {} }, { kind: "risa-assets", config: { overrides: plan.overrides } },
  ] }, { sramBytes: loaded })!;
  try {
    audio.renderAudio(500);
    expect(workingSongName(be.readSram(id)!)).toBe("PORTABLE");
    const archive = project.exportBytes()!;
    expect(project.loadBytes(archive).kind).toBe("loaded");
    audio.setPpq(0); audio.setBpm(120); audio.setTransport(true);
    const pcm = audio.renderAudio(1000);
    audio.setTransport(false); audio.renderAudio(200);
    expect(pcm.some((sample) => Math.abs(sample) > 0.00001)).toBe(true);
    const live = project.systems.view()[0];
    expect(live.roles.find((r) => r.kind === "risa-assets")!.config.overrides).toEqual(plan.overrides);
    expect(listSongs(be.readSram(live.id)!)[0].name).toBe("PORTABLE");
  } finally {
    for (const sys of project.systems.view()) project.systems.removeSystem(sys.id);
  }
});


test("compressed ROM-patcher risong files import into RetroPlug with semantic kit reuse", () => {
  const be = createRealBackend();
  const f = songPackageFixture();
  const file = b64decode(oracle.packageBase64);
  const decoded = decodeSongFile(file, be);
  expect(decoded.kits.size).toBe(1);
  expect(decodeRecord(decoded.record).instruments[0]![10]).toBe(1);
  const plan = planRisaSongImport({ file, path: __CONFIG_DIR__ + "/oracle.risong",
    effectiveRom: f.rom, overrides: [], liveSram: makeEmptySave() }, be);
  expect(plan.addedKits).toBe(0); // SOURCE already occupies slot 5 in this ROM
  expect(equal(recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!, f.record)).toBe(true);
});
