// Regenerate the independent ROM-patcher interoperability fixture.
// RISA_SRC=/path/to/risa node packages/retroplug/scripts/gen-risa-song-package-oracle.mjs
import { buildSync } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const risa = resolve(process.env.RISA_SRC || resolve(pkg, "../../../risa"));
const source = resolve(risa, "tools/rom_patcher");
const fflateModule = { exports: {} };
vm.runInNewContext(readFileSync(resolve(source, "lib/fflate.js"), "utf8"), {
  module: fflateModule, exports: fflateModule.exports, require,
  Uint8Array, Uint16Array, Int32Array, TextEncoder, TextDecoder, setImmediate, setTimeout,
});
const fflate = fflateModule.exports;
globalThis.fflate = fflate;
const { RomImage } = await import(pathToFileURL(resolve(source, "src/rom.js")));
const { exportSongPackage } = await import(pathToFileURL(resolve(source, "src/save_manager/song_package.js")));
const { parseSongRecord } = await import(pathToFileURL(resolve(source, "src/save_manager/record_codec.js")));
const code = buildSync({
  entryPoints: [resolve(pkg, "test/risa/songPackageFixture.ts")], bundle: true,
  platform: "node", mainFields: ["module", "main"], format: "cjs", target: "es2020", write: false,
}).outputFiles[0].text;
const module = { exports: {} };
new Function("module", "exports", "require", code)(module, module.exports, require);
const fixture = module.exports.songPackageFixture();
const rom = new RomImage(fixture.rom.buffer);
rom.setKitBank(5, new Uint8Array(8192));
rom.setKitBank(1, fixture.bank);
const record = fixture.record.slice();
record[parseSongRecord(record).instrumentOffsets[0] + 10] = 1;
const archive = new Uint8Array(await exportSongPackage({ rom,
  entry: { recordBytes: record, name: "PORTABLE", recordVersion: 7, index: 0 } }));
const compressed = fflate.zipSync(fflate.unzipSync(archive), { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
const fixturePath = resolve(pkg, "test/risa/golden/song-package-oracle.json");
writeFileSync(fixturePath, JSON.stringify({
  source: "Risa ROM patcher song_package.js export, ZIP recompressed with fflate (synthetic PORTABLE song and SOURCE kit).",
  packageBase64: Buffer.from(compressed).toString("base64"),
}, null, 2) + "\n");
console.log(`wrote ${fixturePath} (${compressed.length} ZIP bytes)`);
