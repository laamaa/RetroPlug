import { risaRomFull } from "../systems/fixtures";
import { initWorkingDefaults, readWorking } from "../../src/risa/codec/working";
import { encodeRecord } from "../../src/risa/codec/record";
import { RisaRom, assembleKitBank } from "../../src/risa/rom";

export function songPackageFixture() {
  const model = readWorking(initWorkingDefaults());
  model.name = "PORTABLE";
  model.song[4][0] = 0;
  const chain = new Uint8Array(32);
  for (let row = 0; row < 16; row++) chain[row * 2] = 255;
  chain[0] = 0;
  model.chains[0] = chain;
  const phrase = new Uint8Array(64);
  for (let row = 0; row < 16; row++) { phrase[row * 4] = 255; phrase[row * 4 + 1] = 255; }
  phrase.set([0, 0, 0, 0]);
  phrase.set([1, 255, 0, 0], 4);
  model.phrases[0] = phrase;
  model.instruments[0] = new Uint8Array([15, 0, 0, 0, 0, 0, 3, 255, 0, 0, 5, 0]);
  const bank = assembleKitBank("SOURCE", [{ dpcm: new Uint8Array(17).fill(0x55), rate: 8, loop: true, name: "ONE" }]);
  const rom = RisaRom.fromBytes(risaRomFull());
  rom.setKit(5, bank);
  const record = encodeRecord(model);
  record[11] = 0xa7; // reserved bytes must survive kit remapping
  record[15] = 0x5c;
  return { record, bank, rom: rom.bytes(), model };
}
