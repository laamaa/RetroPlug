import { test, expect } from "../../testing/harness";
import { MockBackend } from "../../testing/mockBackend";
import { songPackageFixture } from "./songPackageFixture";
import { risaRomFull } from "../systems/fixtures";
import { encodeSongPackage, decodeSongFile, songDependencies } from "../../src/risa/songPackage";
import { getKitFingerprintPair, getLegacyKitSemanticFingerprint } from "../../src/risa/kitFingerprint";
import { planRisaSongImport } from "../../src/risaSongImport";
import { RisaRom } from "../../src/risa/rom";
import { decodeRecord, encodeRecord, remapRecordDmcKits } from "../../src/risa/codec/record";
import { makeEmptySave, recordBytesAt, CURRENT_LAYOUT } from "../../src/risa/codec/sav";
import { applyOverridesToRom } from "../../src/risaAssetsRole";

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function setup() {
  const be = new MockBackend("/cfg");
  const fixture = songPackageFixture();
  const file = encodeSongPackage(fixture.record, fixture.rom, be, 3);
  const args = { file, path: "/songs/portable.risong", effectiveRom: risaRomFull(), overrides: [], liveSram: makeEmptySave() };
  be.seed(args.path, file);
  return { be, ...fixture, args };
}

test("risong export packages the exact record and referenced DPCM kit", () => {
  const { be, record, bank, args } = setup();
  const entries = be.unzip(args.file)!;
  expect(entries.map((e) => e.name)).toEqual(["song_record.bin", "kits/5.bin", "manifest.json"]);
  const decoded = decodeSongFile(args.file, be);
  expect(equal(decoded.record, record)).toBe(true);
  expect(equal(decoded.kits.get(5)!, bank)).toBe(true);
});

test("instrument-only rows retain their kit dependency for inherited notes", () => {
  const { model } = songPackageFixture();
  model.phrases[0]![0] = 255;
  expect(songDependencies(encodeRecord(model)).kits).toEqual([5]);
});

test("package import adds a missing kit without replacing existing kits or working RAM", () => {
  const { be, args, record, bank } = setup();
  const before = args.liveSram.slice();
  const plan = planRisaSongImport(args, be);
  expect(plan.addedKits).toBe(1);
  expect(plan.overrides[0].slot).toBe(1);
  expect(plan.overrides[0].risongKit).toBe(5);
  expect(equal(args.liveSram, before)).toBe(true);
  expect(equal(plan.savBytes.subarray(0, 0x8000), before.subarray(0, 0x8000))).toBe(true);
  const imported = recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!;
  expect(decodeRecord(imported).instruments[0]![10]).toBe(1);
  expect(equal(remapRecordDmcKits(imported, new Map([[1, 5]])), record)).toBe(true);
  const patched = RisaRom.fromBytes(applyOverridesToRom(args.effectiveRom, plan.overrides, be));
  expect(equal(patched.getKitBank(0)!, RisaRom.fromBytes(args.effectiveRom).getKitBank(0)!)).toBe(true);
  expect(equal(patched.getKitBank(1)!, bank)).toBe(true);
  expect(patched.kits().find((k) => k.slot === 1)!.name).toBe("SOURCE");
});

test("semantic kit matching reuses a bank with different unused padding", () => {
  const { be, args, bank } = setup();
  const target = RisaRom.fromBytes(args.effectiveRom);
  const padded = bank.slice(); padded[1000] = 23;
  target.setKit(7, padded);
  const plan = planRisaSongImport({ ...args, effectiveRom: target.bytes() }, be);
  expect(plan.addedKits).toBe(0);
  expect(decodeRecord(recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!).instruments[0]![10]).toBe(7);
});

test("old raw risong files remain readable and byte-exact", () => {
  const { be, args, record, rom } = setup();
  expect(decodeSongFile(record, be).packaged).toBe(false);
  const plan = planRisaSongImport({ ...args, file: record, effectiveRom: rom }, be);
  expect(plan.addedKits).toBe(0);
  expect(equal(recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!, record)).toBe(true);
});

test("corrupt kits and missing required kits are rejected before import", () => {
  const { be, args } = setup();
  const entries = be.unzip(args.file)!;
  entries.find((e) => e.name === "kits/5.bin")!.bytes[0] ^= 1;
  expect(() => planRisaSongImport({ ...args, file: be.zip(entries)! }, be)).toThrow();
  expect(() => decodeSongFile(be.zip(entries.filter((e) => e.name !== "kits/5.bin"))!, be)).toThrow();
  expect(() => decodeSongFile(new Uint8Array([16, 0, 0]), be)).toThrow();
});

test("older semantic fingerprint manifests remain compatible", () => {
  const { be, args, bank } = setup();
  const entries = be.unzip(args.file)!;
  const manifest = entries.find((e) => e.name === "manifest.json")!;
  const json = JSON.parse(new TextDecoder().decode(manifest.bytes));
  json.kits[0].semantic = getLegacyKitSemanticFingerprint(bank);
  manifest.bytes = new TextEncoder().encode(JSON.stringify(json));
  expect(decodeSongFile(be.zip(entries)!, be).kits.size).toBe(1);
  expect(getKitFingerprintPair(bank).semantic.hex === json.kits[0].semantic.hex).toBe(false);
});

test("a full kit region refuses import without changing source bytes", () => {
  const { be, args } = setup();
  const target = RisaRom.fromBytes(args.effectiveRom);
  const bank = target.getKitBank(0)!;
  for (let i = 0; i < 32; i++) target.setKit(i, bank);
  const before = target.bytes().slice();
  expect(() => planRisaSongImport({ ...args, effectiveRom: target.bytes() }, be)).toThrow();
  expect(equal(target.bytes(), before)).toBe(true);
});


test("legacy raw records are upgraded to a firmware-readable record on import", () => {
  const { be, args, model, rom } = setup();
  model.recordVersion = 3;
  model.instruments[0]![7] = 5; // old DMC kit field
  model.instruments[0]![10] = 0;
  const plan = planRisaSongImport({ ...args, file: encodeRecord(model), effectiveRom: rom }, be);
  const imported = decodeRecord(recordBytesAt(plan.savBytes, CURRENT_LAYOUT, 0)!);
  expect(imported.recordVersion).toBe(7);
  expect(imported.instruments[0]![10]).toBe(5);
  expect(imported.instruments[0]![7]).toBe(255);
});

test("replacing a catalog song preserves the working song and changes only the selected record", () => {
  const { be, args, record, rom } = setup();
  const first = planRisaSongImport({ ...args, file: record, effectiveRom: rom }, be);
  const working = first.savBytes.subarray(0, 0x8000).slice();
  const replaced = planRisaSongImport({ ...args, liveSram: first.savBytes, targetSlot: 0 }, be);
  expect(decodeRecord(recordBytesAt(replaced.savBytes, CURRENT_LAYOUT, 0)!).instruments[0]![10]).toBe(1);
  expect(equal(replaced.savBytes.subarray(0, 0x8000), working)).toBe(true);
});
