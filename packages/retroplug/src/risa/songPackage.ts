// Risa's .risong exchange format: a ZIP with a byte-exact catalog record and
// the DPCM kits it needs. Compatible with rom_patcher/save_manager/song_package.js.
import type { ControlPlaneBackend, ZipEntry } from "../backend";
import { z } from "../configSchema";
import { decodeRecord, encodeRecord, remapRecordDmcKits, type RisaRecord } from "./codec/record";
import { readWorking, writeWorking } from "./codec/working";
import {
  CHAIN_COUNT, CHAIN_ROWS, PHRASE_COUNT, PHRASE_ROWS, INST_COUNT, INST_TYPE_FIELD, INST_TYPE_DMC,
  INST_DMC_KIT_FIELD, INST_LAST_FIELD, INST_EMPTY, CHAIN_EMPTY, PHRASE_EMPTY,
  SAVE_MAGIC_VER, SAVE_RECORD_VERSION_V4, SAVE_RECORD_VERSION_V5,
} from "./codec/constants";
import { RisaRom, KIT_BANK_COUNT, validateKitBank } from "./rom";
import { getKitFingerprintPair, getLegacyKitSemanticFingerprint } from "./kitFingerprint";

const MANIFEST = "manifest.json";
export const SONG_RECORD = "song_record.bin";
const fingerprint = z.object({ hex: z.string() });
const manifestSchema = z.object({
  format: z.literal("risa-song-package"),
  packageVersion: z.literal(1),
  kits: z.array(z.object({
    sourceIndex: z.number().int().min(0).max(KIT_BANK_COUNT - 1),
    path: z.string(),
    exact: fingerprint,
    semantic: fingerprint,
  })).max(KIT_BANK_COUNT),
});
type ArchiveReader = { unzip?(bytes: Uint8Array): ZipEntry[] | null };

/** Conservative dependency walk: an instrument-only row can establish the DMC
 * timbre for later notes, so include every DMC instrument in reachable phrases. */
function dependenciesOf(song: RisaRecord): {
  chains: number[]; phrases: number[]; instruments: number[]; dmcInstruments: number[]; kits: number[];
} {
  const chains = new Set<number>(), phrases = new Set<number>(), instruments = new Set<number>();
  const dmcInstruments = new Set<number>(), kits = new Set<number>();
  for (const track of song.song) for (const chain of track)
    if (chain !== CHAIN_EMPTY && chain < CHAIN_COUNT) chains.add(chain);
  for (const index of chains) {
    const chain = song.chains[index];
    if (!chain) continue;
    for (let row = 0; row < CHAIN_ROWS; row++) {
      const phrase = chain[row * 2];
      if (phrase !== PHRASE_EMPTY && phrase < PHRASE_COUNT) phrases.add(phrase);
    }
  }
  for (const index of phrases) {
    const phrase = song.phrases[index];
    if (!phrase) continue;
    for (let row = 0; row < PHRASE_ROWS; row++) {
      const index = phrase[row * 4 + 1];
      if (index === INST_EMPTY || index >= INST_COUNT) continue;
      instruments.add(index);
      const inst = song.instruments[index];
      if (!inst || inst[INST_TYPE_FIELD] !== INST_TYPE_DMC) continue;
      dmcInstruments.add(index);
      const kit = inst[song.recordVersion >= SAVE_RECORD_VERSION_V4 ? INST_DMC_KIT_FIELD : INST_LAST_FIELD];
      if (kit >= KIT_BANK_COUNT) throw new Error(`Song references invalid kit ${kit}`);
      kits.add(kit);
    }
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { chains: sorted(chains), phrases: sorted(phrases), instruments: sorted(instruments),
    dmcInstruments: sorted(dmcInstruments), kits: sorted(kits) };
}

export function songDependencies(record: Uint8Array): ReturnType<typeof dependenciesOf> {
  return dependenciesOf(decodeRecord(record));
}

export function encodeSongPackage(record: Uint8Array, romBytes: Uint8Array,
                                   archive: Pick<ControlPlaneBackend, "zip">, sourceSlotIndex?: number): Uint8Array {
  const rom = RisaRom.fromBytes(romBytes);
  if (!rom.isRisa) throw new Error("Cannot read the Risa ROM for this song");
  const song = decodeRecord(record);
  const dependencies = dependenciesOf(song);
  const entries: ZipEntry[] = [{ name: SONG_RECORD, bytes: record }];
  const kits = dependencies.kits.map((index) => {
    const bytes = rom.getKitBank(index);
    if (!bytes || !rom.isKitPopulated(index)) throw new Error(`Song references empty ROM kit ${index}`);
    validateKitBank(bytes);
    const path = `kits/${index}.bin`;
    entries.push({ name: path, bytes });
    return { sourceIndex: index, path, ...getKitFingerprintPair(bytes) };
  });
  const manifest = { format: "risa-song-package", packageVersion: 1, saveMagicVersion: SAVE_MAGIC_VER,
    catalogVersion: 2, recordVersion: song.recordVersion, songName: song.name,
    sourceSlotIndex: sourceSlotIndex ?? null, dependencies, kits, sourceRom: { crc32: null } };
  entries.push({ name: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") });
  const bytes = archive.zip(entries);
  if (!bytes) throw new Error("Could not create the song package");
  return bytes;
}

export interface SongFile {
  record: Uint8Array;
  kits: Map<number, Uint8Array>;
  packaged: boolean;
}

export function decodeSongFile(file: Uint8Array, archive: ArchiveReader): SongFile {
  // RetroPlug previously wrote raw records under this extension. Keep those
  // readable, but validate the payload before it can enter a live catalog.
  if (file[0] !== 0x50 || file[1] !== 0x4b || file[2] !== 3 || file[3] !== 4) {
    decodeRecord(file);
    return { record: file.slice(), kits: new Map(), packaged: false };
  }
  const entries = archive.unzip?.(file);
  if (!entries) throw new Error("Cannot read this .risong ZIP package");
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (files.has(entry.name)) throw new Error(`Duplicate song package entry: ${entry.name}`);
    files.set(entry.name, entry.bytes);
  }
  const json = files.get(MANIFEST), record = files.get(SONG_RECORD);
  if (!json || !record) throw new Error("Song package needs manifest.json and song_record.bin");
  const parsedManifest = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(json)));
  if (!parsedManifest.success) throw new Error("Invalid or unsupported .risong manifest");
  const manifest = parsedManifest.data;
  const dependencies = songDependencies(record);
  const kits = new Map<number, Uint8Array>();
  for (const kit of manifest.kits) {
    if (kits.has(kit.sourceIndex)) throw new Error(`Duplicate bundled kit ${kit.sourceIndex}`);
    const bytes = files.get(kit.path);
    if (!bytes) throw new Error(`Bundled kit ${kit.sourceIndex} is missing`);
    validateKitBank(bytes);
    const actual = getKitFingerprintPair(bytes);
    if (actual.exact.hex !== kit.exact.hex) throw new Error(`Bundled kit ${kit.sourceIndex} checksum mismatch`);
    if (actual.semantic.hex !== kit.semantic.hex && getLegacyKitSemanticFingerprint(bytes).hex !== kit.semantic.hex)
      throw new Error(`Bundled kit ${kit.sourceIndex} fingerprint mismatch`);
    kits.set(kit.sourceIndex, bytes);
  }
  for (const kit of dependencies.kits)
    if (!kits.has(kit)) throw new Error(`Song package is missing required kit ${kit}`);
  return { record: record.slice(), kits, packaged: true };
}

/** Legacy records need conversion for current firmware. Current-format records
 * stay opaque; kit remapping changes only their instrument index bytes. */
export function importedSongRecord(record: Uint8Array, kitMap: ReadonlyMap<number, number>): Uint8Array {
  const compatible = record[10] < SAVE_RECORD_VERSION_V5
    ? encodeRecord(readWorking(writeWorking(decodeRecord(record)))) : record;
  return remapRecordDmcKits(compatible, kitMap);
}
