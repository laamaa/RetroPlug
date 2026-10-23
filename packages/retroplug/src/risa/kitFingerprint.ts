// Compatible with Risa rom_patcher/src/kit_fingerprint.js. Names, rates, loop
// flags and sounding sample bytes define kit identity; padding does not.
interface FingerprintOptions { includeKitName?: boolean; includeSampleNames?: boolean }
import {
  KIT_BANK_SIZE,
  KIT_SAMPLE_REGION,
  KIT_NAME_OFFSET,
  KIT_NAME_SIZE,
  KIT_SAMPLE_NAMES,
  KIT_SAMPLE_NAME_LEN,
  KIT_SLOT_COUNT,
  KIT_INDEX_OFFSET,
  KIT_INDEX_ENTRY,
  KIT_SLOT_EMPTY,
  KIT_FLAG_LOOP,
  SAMPLE_ALIGN,
  LENGTH_STEP,
} from "./rom/constants";

const dmcByteLengthFromRegister = (len: number): number => len * LENGTH_STEP + 1;

const CRC32_POLY = 0xEDB88320;
const CRC32_INIT = 0xFFFFFFFF;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 1) ? (CRC32_POLY ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Start() {
  return CRC32_INIT;
}

function crc32UpdateByte(crc: number, byte: number) {
  return (CRC32_TABLE[(crc ^ (byte & 0xFF)) & 0xFF] ^ (crc >>> 8)) >>> 0;
}

function crc32UpdateBytes(crc: number, bytes: Uint8Array, start = 0, end = bytes.length) {
  for (let i = start; i < end; i++) crc = crc32UpdateByte(crc, bytes[i]);
  return crc >>> 0;
}

function crc32UpdateU32(crc: number, value: number) {
  crc = crc32UpdateByte(crc, value & 0xFF);
  crc = crc32UpdateByte(crc, (value >>> 8) & 0xFF);
  crc = crc32UpdateByte(crc, (value >>> 16) & 0xFF);
  crc = crc32UpdateByte(crc, (value >>> 24) & 0xFF);
  return crc >>> 0;
}

function crc32Finish(crc: number) {
  return (~crc) >>> 0;
}

function crc32HexFromState(crc: number) {
  return crc32Finish(crc).toString(16).padStart(8, "0");
}

function semanticFlags(flags: number) {
  return flags & KIT_FLAG_LOOP;
}

function legacyDmcByteLengthFromRegister(lenReg: number) {
  return (lenReg + 1) * LENGTH_STEP + 1;
}

function slotDataRange(bankBytes: Uint8Array, slot: number, byteLengthFromRegister: (len: number) => number) {
  const pos = KIT_INDEX_OFFSET + slot * KIT_INDEX_ENTRY;
  const addr = bankBytes[pos + 0];
  const lenReg = bankBytes[pos + 1];
  if (addr === KIT_SLOT_EMPTY) return null;

  const start = addr * SAMPLE_ALIGN;
  const length = byteLengthFromRegister(lenReg);
  const end = start + length;
  if (end > KIT_SAMPLE_REGION) {
    return {
      valid: false as const,
      addr,
      lenReg,
      rate: bankBytes[pos + 2],
      flags: bankBytes[pos + 3],
    };
  }

  return {
    valid: true as const,
    addr,
    lenReg,
    rate: bankBytes[pos + 2],
    flags: bankBytes[pos + 3],
    start,
    end,
  };
}

export function crc32Hex(bytes: Uint8Array, start = 0, end = bytes.length) {
  return crc32HexFromState(crc32UpdateBytes(crc32Start(), bytes, start, end));
}

export function getKitExactFingerprint(bankBytes: Uint8Array) {
  if (bankBytes.length !== KIT_BANK_SIZE) {
    throw new Error(`Expected ${KIT_BANK_SIZE} bytes for kit bank, got ${bankBytes.length}`);
  }
  return {
    algorithm: "crc32",
    kind: "exact",
    hex: crc32Hex(bankBytes),
  };
}

function getKitSemanticFingerprintWithLength(bankBytes: Uint8Array, options: FingerprintOptions, byteLengthFromRegister: (len: number) => number) {
  if (bankBytes.length !== KIT_BANK_SIZE) {
    throw new Error(`Expected ${KIT_BANK_SIZE} bytes for kit bank, got ${bankBytes.length}`);
  }

  const includeKitName = options.includeKitName !== false;
  const includeSampleNames = options.includeSampleNames !== false;
  let crc = crc32Start();

  crc = crc32UpdateBytes(crc, new Uint8Array([
    0x52, 0x49, 0x53, 0x41, 0x2D, 0x4B, 0x49, 0x54, 0x2D, 0x53, 0x45, 0x4D, 0x31,
    includeKitName ? 1 : 0,
    includeSampleNames ? 1 : 0,
  ]));

  if (includeKitName) {
    crc = crc32UpdateBytes(crc, bankBytes, KIT_NAME_OFFSET, KIT_NAME_OFFSET + KIT_NAME_SIZE);
  }

  for (let slot = 0; slot < KIT_SLOT_COUNT; slot++) {
    const range = slotDataRange(bankBytes, slot, byteLengthFromRegister);
    crc = crc32UpdateByte(crc, slot);

    if (!range) {
      crc = crc32UpdateByte(crc, 0);
      continue;
    }

    crc = crc32UpdateByte(crc, 1);

    if (includeSampleNames) {
      const nameOff = KIT_SAMPLE_NAMES + slot * KIT_SAMPLE_NAME_LEN;
      crc = crc32UpdateBytes(crc, bankBytes, nameOff, nameOff + KIT_SAMPLE_NAME_LEN);
    }

    if (!range.valid) {
      crc = crc32UpdateByte(crc, 0);
      crc = crc32UpdateByte(crc, range.addr);
      crc = crc32UpdateByte(crc, range.lenReg);
      crc = crc32UpdateByte(crc, range.rate);
      crc = crc32UpdateByte(crc, semanticFlags(range.flags));
      continue;
    }

    crc = crc32UpdateByte(crc, 1);
    crc = crc32UpdateByte(crc, range.rate);
    crc = crc32UpdateByte(crc, semanticFlags(range.flags));
    crc = crc32UpdateU32(crc, range.end - range.start);
    crc = crc32UpdateBytes(crc, bankBytes, range.start, range.end);
  }

  return {
    algorithm: "crc32",
    kind: "semantic",
    hex: crc32HexFromState(crc),
    options: {
      includeKitName,
      includeSampleNames,
    },
  };
}

export function getKitSemanticFingerprint(bankBytes: Uint8Array, options: FingerprintOptions = {}) {
  return getKitSemanticFingerprintWithLength(bankBytes, options, dmcByteLengthFromRegister);
}

// Packages exported before the length fix hashed one extra 16-byte block.
// Keep this decoder only for validating those existing manifests.
export function getLegacyKitSemanticFingerprint(bankBytes: Uint8Array, options: FingerprintOptions = {}) {
  return getKitSemanticFingerprintWithLength(bankBytes, options, legacyDmcByteLengthFromRegister);
}

export function getKitFingerprintPair(bankBytes: Uint8Array, options: FingerprintOptions = {}) {
  return {
    exact: getKitExactFingerprint(bankBytes),
    semantic: getKitSemanticFingerprint(bankBytes, options),
  };
}
