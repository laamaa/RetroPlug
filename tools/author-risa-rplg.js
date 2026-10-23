// Author a risa `.rplg.zip` fixture (ROM embedded + the authored .srm battery) for the reaper risa
// host-sync render: esbuild author-risa-rplg.ts (injecting the ROM + output path) and run it on
// retroplug-host, which EXPORTS a PKZIP `.rplg.zip`. Counterpart of tools/author-nes-rplg.js (n8-midi)
// and tools/author-lsdj-rplg.js.
//
//   node tools/author-risa-rplg.js [ROM] [OUT.rplg.zip]
//     ROM   default $RISA_SRC/build/risa-pal.nes, or ../risa/build/risa-pal.nes
//     OUT   default build/risa.rplg.zip
//
// Build a current Risa ROM first. Missing fixtures skip the render on machines
// without that checkout; an explicitly supplied unsupported ROM is rejected.
const { buildSync } = require("esbuild");
const { execFileSync } = require("child_process");
const { resolve, dirname } = require("path");
const { mkdirSync, existsSync } = require("fs");

const REPO = resolve(__dirname, "..");
const PKG = resolve(REPO, "packages/retroplug");
const HOST = process.env.RETROPLUG_HOST || resolve(REPO, "build/bin/retroplug-host");

const ROM = resolve(REPO, process.argv[2] || resolve(process.env.RISA_SRC || resolve(REPO, "../risa"), "build/risa-pal.nes"));
const OUT = resolve(process.argv[3] || resolve(REPO, "build/risa.rplg.zip"));

if (!existsSync(ROM)) {
  console.log(`[author-risa-rplg] SKIP: risa ROM not found at ${ROM}`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
const bundle = resolve(REPO, "build/native/author-risa-rplg.js");
mkdirSync(dirname(bundle), { recursive: true });

buildSync({
  entryPoints: [resolve(PKG, "test-native/author-risa-rplg.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2020",
  outfile: bundle,
  define: {
    "process.env.NODE_ENV": '"production"',
    __RISA_ROM__: JSON.stringify(ROM),
    __RPLG_OUT__: JSON.stringify(OUT),
  },
});

execFileSync(HOST, [bundle], { stdio: "inherit" });
console.log(`authored ${OUT}`);
