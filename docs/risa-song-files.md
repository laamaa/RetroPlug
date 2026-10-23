# Risa song files

Risa's Songs menu exports `.risong` packages compatible with the Risa ROM
patcher. A package contains `song_record.bin`, `manifest.json` (package version
1), and the DPCM kit banks referenced by the song. Export uses the cartridge's
effective ROM, including existing sample-kit overrides. Use the ROM that
contains the song's samples; a save file alone does not contain them.

Use **Songs > Add...** to import a package, or **Replace...** on a saved song to
replace that catalog entry. Import validates the record and bundled kit
fingerprints, reuses matching sample kits, and assigns free kit slots for
missing ones. It remaps the imported song's DMC kit indices and updates the
on-ROM kit metadata in memory. Other songs, existing kits, and the working
song are preserved. A full catalog, full kit region, or invalid package reports
an error instead of silently doing nothing. If cartridge reload fails, the
previous save file and kit bindings are restored.

New kit overrides link to the imported `.risong` file, like other linked ROM
assets. Keep that file available alongside your project. Export to a new
filename when the existing file supplies assets to the project. The base `.nes` file
is not modified. Imported kits can also be exported separately as `.rkit`
banks through the Kits menu.

Older raw-record `.risong` files exported by RetroPlug remain readable. They
carry no sample kits and retain their original kit indices, so use the matching
ROM for them. New exports always use the portable package format.

Validation:

- `pnpm test risa/song-package` checks kit remapping, deduplication, record
  preservation, legacy raw files and malformed/full imports.
- `pnpm test menu/risa` exercises Export, Add, re-export and kit export through
  the actual menu actions, plus visible failure reporting.
- `RISA_SRC=/path/to/risa pnpm test:native risa-song-package` checks the native
  ZIP codec, a compressed fixture exported by the ROM patcher, and DPCM output
  after a real Risa boot and project reload.
- Regenerate the independent fixture with
  `RISA_SRC=/path/to/risa node scripts/gen-risa-song-package-oracle.mjs` from
  `packages/retroplug/`.
