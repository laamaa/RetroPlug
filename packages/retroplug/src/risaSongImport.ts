// Plan song + sample-kit import before changing either the battery or ROM roles.
import type { ControlPlaneBackend } from "./backend";
import type { RisaAssetOverride } from "./risaAssetsRole";
import { RisaRom, KIT_BANK_COUNT, bankToModel } from "./risa/rom";
import { getKitSemanticFingerprint } from "./risa/kitFingerprint";
import { decodeSongFile, importedSongRecord, songDependencies } from "./risa/songPackage";
import { addSongRecordToSav, replaceSongRecordInSav } from "./risaSongOps";

export function planRisaSongImport(args: {
  file: Uint8Array; path: string; effectiveRom: Uint8Array;
  overrides: RisaAssetOverride[]; liveSram: Uint8Array; targetSlot?: number;
}, archive: Pick<ControlPlaneBackend, "unzip">): { savBytes: Uint8Array; overrides: RisaAssetOverride[]; addedKits: number } {
  const file = decodeSongFile(args.file, archive);
  const rom = RisaRom.fromBytes(args.effectiveRom);
  if (!rom.isRisa) throw new Error("Cannot read the target Risa ROM");
  const existing = new Map<string, number>();
  if (file.kits.size) for (let slot = 0; slot < KIT_BANK_COUNT; slot++) {
    if (rom.isKitPopulated(slot)) existing.set(getKitSemanticFingerprint(rom.getKitBank(slot)!).hex, slot);
  }
  const kitMap = new Map<number, number>();
  let overrides = [...args.overrides];
  let addedKits = 0;
  for (const sourceIndex of songDependencies(file.record).kits) {
    const bank = file.kits.get(sourceIndex);
    if (!bank) continue; // old raw-record files carry no kit banks
    const semantic = getKitSemanticFingerprint(bank).hex;
    let slot = existing.get(semantic);
    if (slot === undefined) {
      slot = rom.firstFreeKitIndex();
      if (slot < 0) throw new Error("No free DPCM kit slot in the target ROM");
      rom.setKit(slot, bank);
      existing.set(semantic, slot);
      overrides = overrides.filter((ov) => ov.type !== "kit" || ov.slot !== slot);
      overrides.push({ type: "kit", slot, name: bankToModel(bank).name, path: args.path, risongKit: sourceIndex });
      addedKits++;
    }
    kitMap.set(sourceIndex, slot);
  }
  const record = importedSongRecord(file.record, kitMap);
  const savBytes = args.targetSlot === undefined
    ? addSongRecordToSav(args.liveSram, record)
    : replaceSongRecordInSav(args.liveSram, args.targetSlot, record);
  return { savBytes, overrides, addedKits };
}
