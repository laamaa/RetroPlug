# Sixteen-output expansion audio implementation plan

> Execute inline using the executing-plans and test-driven-development skills.

**Goal:** Widen the existing plugin to 16 outputs and include individual NES expansion voices in Channels.

**Architecture:** Keep the first eight plugin port identities and all routing enum values. Channels emits five base mono voices followed by the mapper's fixed voice layout (up to eight N163 voices); Pins and Stereo Pins keep their combined expansion stream. Mapper taps feed independent band-limited/resampled streams without changing the mixed audio path.

**Tech stack:** C++, vendored Mesen, TypeScript, DPF, Catch2 and the native test host.

**Spec:** `spec/10-multichannel-audio-out.md`, amended by the user's explicit choice to widen the existing plugin to 16.

## Constraints and review focus

- Preserve unrelated dirty submodules; no submodule pointer changes, commits or pushes.
- Keep a fixed layout per mapper, including disabled N163 voices, so routing never changes during playback.
- Preserve chip scaling, expansion volume, sample rate changes, savestate reset and live routing switches.
- Narrow hosts must fall back safely; check upper output lanes and silence beyond the layout.
- Existing DAW sessions retain first-eight names/order; real-host restore compatibility needs separate evidence.

## Tasks

1. [x] Add real-core expansion isolation tests and run them to establish the missing streams.
2. [x] Add mapper voice taps and extend mixer/system capture to 13 streams; keep base stems and pin modes intact.
3. [x] Widen plugin ports to 16 and test real Engine routing above lane eight, including narrow-host fallback.
4. [x] Update render filenames/collision detection for expansion stems and update documentation.
5. [x] Build canonical app/plugin targets; run audio, native, render and UI checks; review the complete diff.

## Execution record

- Initial investigation: expansion-only VRC6 note produced RMS 0 in all five Channels streams and nonzero output in mix/Pins. Existing routing tests passed but did not drive expansion voices.

- Implemented per-clock absolute mapper taps into independent blips, rather than widening the mixer's per-cycle delta arrays. Preserved mixed/pin paths and project/save schemas.
- Added FDS single-voice state metadata for naming, plus a synthetic FDS audio test that executes from RAM without a copyrighted BIOS.
- Extended the SDL device picker and accepted/persisted output counts through 16.
- Red/green evidence: all five committed expansion ROMs initially returned five silent base stems; expansion filename collision initially produced generic ch5 files; compiled CLAP initially reported eight channels; UI initially cycled only through eight. Each now passes.
- Validation: canonical build.sh succeeded; 153 TS test files, 125 native files (96 fixture-dependent cases skipped), 40 UI files (3 fixture-dependent cases skipped), and all 101 C++ audio cases passed. Typecheck, documentation links and diff whitespace checks passed.
- Independent read-only review found no critical or important issues. Original CLAP output port IDs 2147483648..2147483651 remain unchanged; new pairs append IDs 2147483652..2147483655.
- Remaining evidence boundary: existing eight-output session restore in a real DAW, listening, and physical multichannel interface operation were not tested. Implementation was left uncommitted until the subsequent explicit review-and-commit request; no pushes or submodule pointer changes.

## Simplify review

- Three independent passes reviewed reuse, quality and efficiency before cleanup.
- Reused the existing test RMS helper and replaced per-block layout construction during capture discard with the mixer's existing stream count.
- Corrected stale layout descriptions in comments and the spec index.
- Preserved N163's existing clock-stop/held-DAC behavior. Forcing zero only in stems would diverge from the existing mixed path; removed an unreachable disable check and clarified that the test measures silence after highpass decay.
- Kept native display names and TS filename names separate: merging those representations would require an unrelated metadata API change.
