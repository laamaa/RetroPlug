# Risa DAW seeking

Risa ROMs with both `RISAxyz` and `RSEEK1` in the first `$150` file bytes
support resolved, independent-track seeking. RetroPlug selects it automatically;
older ROMs retain the legacy structural locate. Capability is re-derived on
project restore and ROM reload, rather than trusted from saved configuration.

The plugin now forwards the host's absolute quarter-note position before
rendering every block. A tracked configure-time DPF patch preserves the native
VST2/VST3/CLAP/AU musical position alongside BBT, avoiding meter-dependent
reconstruction and current-BPM/sample-time conversion. Negative preroll gates
sequencer transport until song zero. Hosts lacking valid musical position use
the Engine's predicted clock.

Cold Risa construction advances 2500 ms of emulation before handing the core
to the audio thread, discarding that output. This runs on the constructing
control thread and never advances a restored savestate. It prevents an idle,
unarmed REAPER instrument track from postponing ROM boot until Play.

On start, resume, seek or loop discontinuity, the `risa-sync` role gates old
playback and requests a fresh preparation. The audio/block owner copies the live
32 KB cartridge working image into a bounded mailbox. A private QuickJS worker
uses `src/risa/seek.ts` to resolve the target, so neither the 6502 nor the audio
callback builds the timeline. No editor or UI polling is required.
The worker lives for the DSP runtime; kernel reloads invalidate requests and
replace its private JS context on the worker thread.

The model follows each track's chains, song islands, phrase grooves, Gxx,
bounded counted HOPs, H0Y and HFF. It skips row durations, records a finite path
and detects repeating state. Later lookups use modulo and binary search. Exact
comparison of relevant song bytes invalidates cached models, including unsaved
in-ROM edits; runtime scratch is excluded. An explicit 262144-event-per-track
preparation limit bounds exceptionally complex/malformed songs. Models are
cached for at most 64 system IDs.

The worker returns the request token, resolved clock and a 48-byte `F9 53`
packet: an active mask followed by five independent row/groove/HOP/countdown/
inherited-instrument records. Risa stages this in unused cartridge scratch and
primes it through the guarded interrupt path. HOPs are already resolved; notes
and ordinary row effects execute once. The remaining per-track countdowns are
installed before subsequent external clocks are released.

Obsolete worker generations and responses to changed song bytes are rejected.
Core replacement invalidates in-flight work. There is no accumulated-time scan
on the NES.

With the additional `RREADY1` ROM marker, RetroPlug warms the model while the
DAW is stopped, without claiming the ROM or interfering with previews. Play
captures fresh bytes and resolves the **original** start position. The complete
packet prepares that position silently. The marker carries little-endian RAM
addresses of the preparation state and generation; the audio-thread owner
provides side-effect-free RAM reads. Start is released only after the new
generation acknowledges state 5 (structurally armed).

REAPER derives positions from integer sample times, so an exact bar boundary
can arrive fractionally below its PPQ value. Within one host sample of an
integer 24-PPQN clock, the start rounds to that clock; actual positions further
before the boundary retain the preceding clock.

Start and every clock are scheduled 100 ms behind their original host sample
timestamps. The plugin reports the same 100 ms for host delay compensation
(PDC), as it already does for LSDj's smaller clock latency. The editor refreshes
the report after ROM changes even when CC labels stay unchanged, and sample-rate
changes recompute frames from the cached duration without entering control-plane
JS. A configure-time VST3 patch publishes the updated latency value to the
controller instead of the previous cached value. This also preserves
timing through tempo changes and delays Stop to the matching clock boundary.
The first row is never shortened by a catch-up burst. Warm-up needs stopped
audio callbacks; if unusually slow preparation or a fast offline render exceeds
the allowance, the entire stream starts later to preserve the first row. That
extra delay is not covered by the fixed PDC report. Pending startup timing
history is bounded to 512 clocks, then preparation retries at current time.

`RSEEK1` ROMs without `RREADY1` retain the previous immediate-start path, with
at most 24 elapsed clocks replayed after worker preparation.

This targets musical position and clock phase. The readiness handshake and PDC
cover startup preparation within the allowance; the ROM still quantizes service
to safe subframes. Sustained notes, envelopes,
tables, delays and oscillator phase are not replayed from the past; inherited
timbre can restart on the located row. Sample-exact DAW onset/listening and
physical N8 USB behavior need separate qualification. The standalone MIDI/SPP
translator still uses the legacy structural packet.

Validation added:

- `pnpm test risa/seek` and `pnpm test dsp/risa-resolved-sync`: model and role
  transaction/catch-up/generation/preroll/readiness/timestamp tests.
- `RISA_SRC=/path/to/risa pnpm test:native dsp-risa-resolved-seek`: fresh live
  cartridge edits without an editor, actual clocked seeks/rewinds at 120/295
  BPM, and PAL/NTSC differential comparisons with continuous playback across
  chain lengths, grooves, hops and high-bank phrases, plus prepared starts and
  the delayed steady clock at both tempos and regions. Requires current built
  Risa ROMs and matching labels. Missing fixtures count as skips.
- `retroplug-plugin-test [transport]`: host position assignment, rewind,
  fallback and preroll tests. Normal plugin targets compile the DPF format
  changes as part of the build; this is not an actual DAW-hosted test.
- `retroplug-plugin-test [seek-worker]`: duplicate request coalescing, kernel
  replacement, unlocked delivery, song edit invalidation and clock fallback.

REAPER startup qualification also uses an isolated profile at 145 BPM, with a
copy of the real working save and a ROM change from `RSEEK1` to `RREADY1` through
the editor's watcher. A master JSFX detector compares first onset against a
reference click on the other stereo channel. The host reports 4410 latency
samples at 44.1 kHz after the swap, and the trace resolves bar 9 to row 01 even
when REAPER reports PPQ 31.999955. The temporary profile never modifies the
user's original project/save. This is a host/mixer measurement, not physical
output-device or listening qualification.
