import { test, expect } from "../../testing/harness";
import { MockBackend } from "../../testing/mockBackend";
import { composeAppStores } from "../../src/appStores";
import { buildInstanceMenu, type MenuContext } from "../../ui/screens/menu/menuDefs";
import type { MenuItem } from "../../ui/screens/menu/menuTree";
import { risaRomFull } from "../systems/fixtures";
import { songPackageFixture } from "../risa/songPackageFixture";
import { RisaRom } from "../../src/risa/rom";
import { encodeSongPackage } from "../../src/risa/songPackage";
import { makeEmptySave } from "../../src/risa/codec/sav";

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const children = (items: MenuItem[], id: string) => items.find((i) => i.id === id)?.children ?? [];

function setup(tag: string, rom = risaRomFull()) {
  const be = new MockBackend("/cfg");
  const stores = composeAppStores({ backend: be });
  const path = `/roms/${tag}.nes`;
  be.seed(path, rom);
  const firstId = stores.project.systems.addSystem(path)!;
  const battery = makeEmptySave();
  battery[100] = 0xa7;
  be.setSram(firstId, battery);
  const notices: string[] = [];
  const current = () => stores.project.systems.view()[0];
  const overrides = () => current().roles.find((r) => r.kind === "risa-assets")!.config.overrides;
  const menu = () => {
    const ctx: MenuContext = {
      stores, settings: stores.project.settings(), userConfig: stores.userConfig.config(),
      bindings: stores.bindings.resolvedBindings(), systems: stores.project.systems.view(), recent: [], version: "",
      newProject() {}, loadProject() {}, loadRomAsProject() {}, beginSongImport() {}, requestExit() {}, openLsdjHd() {},
      showSongNotice: (_title, message) => notices.push(message),
    };
    return children(children(buildInstanceMenu({ ...ctx, system: current() }).items, "inst-risa"), "risa-kits");
  };
  const publish = () => be.setSram(current().id, new Uint8Array(be.constructCalls[be.constructCalls.length - 1].sramBytes!));
  const run = async (slot: number, verb: string, file?: string) => {
    if (file) be.queueBrowse(file);
    const row = menu().find((i) => i.id === `risa-kit-${slot}`)!;
    if (row.kind !== "actionCycler") throw new Error("Expected kit actions");
    row.actions!.find((a) => a.id === `risa-kit-${slot}-${verb}`)!.onSelect();
    await flush();
  };
  const add = async (file: string) => {
    be.queueBrowse(file);
    menu().find((i) => i.id === "risa-kit-add")!.onSelect!();
    await flush();
  };
  return { be, stores, path, firstId, battery, notices, current, overrides, menu, publish, run, add };
}

test("raw kit Export, Add, Replace and re-export preserve sample bytes and working SRAM", async () => {
  const f = songPackageFixture();
  const h = setup("kit-roundtrip");
  const base = h.be.readFile(h.path)!;
  await h.run(0, "export", "/out/base.rkit");
  expect(equal(h.be.readFile("/out/base.rkit")!, RisaRom.fromBytes(base).getKitBank(0)!)).toBe(true);
  h.be.seed("/in/source.rkit", f.bank);
  await h.add("/in/source.rkit");
  h.publish();
  let spec = h.be.constructCalls[h.be.constructCalls.length - 1];
  expect(equal(RisaRom.fromBytes(spec.romBytes!).getKitBank(1)!, f.bank)).toBe(true);
  expect(equal(h.stores.project.systems.readSram(h.current().id)!, h.battery)).toBe(true);
  await h.run(1, "export", "/out/again.rkit");
  expect(equal(h.be.readFile("/out/again.rkit")!, f.bank)).toBe(true);
  await h.run(0, "replace", "/out/again.rkit");
  h.publish();
  spec = h.be.constructCalls[h.be.constructCalls.length - 1];
  const patched = RisaRom.fromBytes(spec.romBytes!);
  expect(equal(patched.getKitBank(0)!, f.bank)).toBe(true);
  expect(patched.kits().find((k) => k.slot === 0)!.name).toBe("SOURCE");
  expect(equal(h.be.readFile(h.path)!, base)).toBe(true);
  expect(h.notices).toEqual([]);
});

test("invalid kit imports report errors without changing the cartridge", async () => {
  const h = setup("kit-invalid");
  const malformed = songPackageFixture().bank.slice();
  malformed[0x1f00] = 0xfe; // sample address lands beyond the sample region
  for (const data of [new Uint8Array(4000), new Uint8Array(8192), malformed]) {
    h.be.seed("/in/bad.rkit", data);
    await h.run(0, "replace", "/in/bad.rkit");
  }
  expect(h.notices.length).toBe(3);
  expect(h.notices[2].includes("outside")).toBe(true);
  expect(h.overrides()).toEqual([]);
  expect(h.be.constructCalls.length).toBe(1);
});

test("kit export reports missing or invalid linked files instead of exporting a different bank", async () => {
  const h = setup("kit-missing");
  h.stores.project.systems.setRoleConfig(h.firstId, "risa-assets", { overrides: [
    { type: "kit", slot: 0, name: "MISSING", path: "/in/missing.rkit" },
  ] });
  await h.run(0, "export", "/out/missing.rkit");
  expect(h.be.readFile("/out/missing.rkit")).toBe(null);
  expect(h.notices[0].includes("Cannot read linked asset")).toBe(true);
  h.be.seed("/in/missing.rkit", new Uint8Array(10));
  await h.run(0, "export", "/out/invalid.rkit");
  expect(h.be.readFile("/out/invalid.rkit")).toBe(null);
  expect(h.notices[1].includes("exactly 8 KB")).toBe(true);
});

test("kit export reports a failed file write", async () => {
  const h = setup("kit-write-failed");
  h.be.writeFileAtomic = () => false;
  await h.run(0, "export", "/out/failed.rkit");
  expect(h.notices).toEqual(["Could not export kit"]);
});

test("kit import restores prior bindings if cartridge reconstruction fails", async () => {
  const h = setup("kit-reload-failed");
  h.be.seed("/in/source.rkit", songPackageFixture().bank);
  h.be.constructSystem = () => false;
  await h.add("/in/source.rkit");
  expect(h.overrides()).toEqual([]);
  expect(h.current().id).toBe(h.firstId);
  expect(equal(h.stores.project.systems.readSram(h.firstId)!, h.battery)).toBe(true);
  expect(h.notices).toEqual(["Could not reload the cartridge assets"]);
});

test("kit Add reports a full cartridge", async () => {
  const rom = RisaRom.fromBytes(risaRomFull());
  const bank = songPackageFixture().bank;
  for (let i = 0; i < 32; i++) rom.setKit(i, bank);
  const h = setup("kit-full", rom.bytes());
  await h.add("/in/unused.rkit");
  expect(h.notices).toEqual(["No free kit slot in this cartridge"]);
  expect(h.be.constructCalls.length).toBe(1);
});

test("exporting a kit cannot overwrite its linked song package", async () => {
  const h = setup("kit-linked-package");
  const f = songPackageFixture();
  const file = encodeSongPackage(f.record, f.rom, h.be);
  h.be.seed("/in/source.risong", file);
  h.stores.project.systems.setRoleConfig(h.firstId, "risa-assets", { overrides: [
    { type: "kit", slot: 1, name: "SOURCE", path: "/in/source.risong", risongKit: 5 },
  ] });
  await h.run(1, "export", "/in/./source.risong");
  expect(equal(h.be.readFile("/in/source.risong")!, file)).toBe(true);
  expect(h.notices[0].includes("Export to a new filename")).toBe(true);
});
