# 10 — Multichannel audio output

**Status: built.** The existing plugin exposes **16 output channels as eight stereo pairs**.
Channels separates one Game Boy into four stereo stems, or one NES into five base mono voices plus
its cartridge's individual expansion voices. Pins and Stereo Pins retain the combined expansion stream.
EPSM and simultaneous expansion chips in NSF files remain outside this layout.

## 0. Output contract

The plugin keeps its identity and the original first eight port names, symbols, positions and groups.
Pairs Out 5–8 are appended to Out 1–4. This preserves the identifiers used by existing routing;
restoration of old sessions is a DAW compatibility check, not something a core test establishes.

| Routing | Placement |
|---|---|
| Stereo | All systems mixed into outputs 1–2 |
| 2 Ch / Inst | One stereo pair per system |
| 1 Ch / Inst | One mono output per system |
| Channels (Game Boy) | Pulse1, Pulse2, Wave, Noise on pairs 1–4 |
| Channels (NES) | Five base voices on outputs 1–5, then the mapper voices below |
| Pins (NES) | Pulse, TND, combined Expansion on outputs 1–3 |
| Stereo Pins (NES) | Those same pins mirrored onto pairs 1–3 |

Unused outputs are silent. The three split modes apply only to a single unlinked system; pin modes
additionally require NES. The native engine is the authority for this gate. When the host's actual
output count is narrower than the requested split, the engine falls back to the ordinary stereo mix.
It does not truncate or wrap expansion stems onto the earlier voices.

### NES Channels order

Outputs 1–5 are always Square1, Square2, Triangle, Noise and DMC. The cartridge adds:

| Chip | Expansion order, starting at output 6 | Total mono outputs |
|---|---|---:|
| None | — | 5 |
| VRC6 | Pulse1, Pulse2, Saw | 8 |
| MMC5 | Pulse1, Pulse2, PCM | 8 |
| VRC7 | FM1–FM6 | 11 |
| Namco 163 | Wave1–Wave8 | 13 |
| Sunsoft 5B | Tone1–Tone3 | 8 |
| FDS | Wave | 6 |

N163 Wave1 is hardware slot 7, Wave2 slot 6, and so on. All eight streams remain present when the
active voice count changes; inactive voices are silent. Stream count follows the hardware mapper,
not whether a particular ROM uses that chip (the base BlipToaster cart still carries a 5B mapper).

## 1. Shared host seam

`SystemBase::channelLayout()` describes ordered `{name, stereo}` streams. It is inert until a router
requests them. `AudioRouter::streamCount()` controls the number of stream buses given to
`finishBlock(info, outs, laneCount)`; each internal bus still has L/R pointers.

`Engine::syncSplitPlan()` arms NES capture live on routing/system changes and caches stream count,
stride and required output width. Layout discovery is not performed per audio block. Leaving a split
restores the previous export mode; changing routing does not reset the ROM.

`ChannelSplitRouter` uses stride 2 for stereo stems and stride 1 for mono stems. Mono routing aliases
the internal L/R pointers to one host lane, so mono backends write only their L pointer. For Stereo
Pins, the Engine instead assigns a pair per mono stem and mirrors L to R after rendering. The CLI
keeps each mono stream's unused R lane silent.

`BlockRunner` supports up to 16 internal stereo stream buses; the largest supported NES layout is 13.
The plugin passes 16 physical outputs. The SDL standalone accepts even output counts from 2 through 16,
selected in Settings > Audio > Out Channels; the actual device must support the requested count.

## 2. Game Boy

The tracked [SameBoy patch](../cmake/patches/sameboy-per-channel-audio.patch) taps the four channel
samples after band limiting, NR51 panning, NR50 level and per-stem highpass. Configure applies it
idempotently; a dirty SameBoy working tree is expected. No submodule pointer change is needed.

The four stereo stems occupy outputs 1–8; outputs 9–16 remain silent. Accurate highpass is linear,
so the stems reproduce the corresponding mix within rounding. Remove DC Offset runs independently
per stem and need not sum exactly to the mix's summed-then-filtered DC correction. A hard-panned
voice correctly has one silent side.

## 3. NES extraction

Mesen renders blip buffers at 96 kHz and resamples them to the host rate with independent
`HermiteResampler` instances. Every stem uses that same clock/rate path; raw register snapshots are
not audio sources.

### Pins

The 2A03 has two nonlinear DAC groups: the two pulses share one pin, and Triangle/Noise/DMC share
the other. `NesSoundMixer::GetStreamVolumes` extracts those exact mix terms plus all ordinary
expansion-chip contributions. Mode 2 additionally captures a MixRef for the fidelity test.

Pins reconstruct that reference within the tested rounding tolerance. Stereo Pins changes only
host placement, not the captured audio.

### Individual voices

Mode 3 retains the existing five base voices as pre-DAC linear levels: pulse/triangle/noise scaled
by 1024, DMC by 128. **These five stems do not sum back to the mix**, because they bypass the shared
nonlinear DACs.

The mapper taps emit absolute signed voice levels at their actual APU timestamps through
`NesApu::CaptureExpansionOutput`. The mixer feeds each expansion blip directly; base voices continue
through the mixer's sorted delta timestamps. This avoids introducing a second per-cycle delta array.

- VRC6 taps both pulse outputs and saw, retaining the chip's ×15 contribution before mixer gain.
- MMC5 taps the two pulse outputs and PCM DAC separately, retaining their inverted polarity.
- VRC7 reads `OPLL::ch_out[0..5]` after `OPLL_calc`. Its OPLL runs at clock/72, its native sample rate,
  so those signed values are the actual mix summands; no emu2413 modification is required.
- N163 taps all eight held voice values, dividing by the active count like the chip's mixed path.
  Individual rounding can differ from rounding the sum.
- 5B taps each tone/noise/envelope-gated contribution after the existing amplitude lookup.
- FDS already has a single voice in the mixer's FDS delta, so it uses that value directly.

Expansion stems retain mixed-path chip gains and the live Expansion Volume setting. Isolated values
are clamped before int16 conversion to avoid amplification wrapping their polarity. Capture is gated
off on ordinary mixed/pin paths. It adds no serialized fields or project schema changes.

Re-arming clears the stem blips, previous values and resamplers. Savestate load clears derived capture
state; mapper voices repopulate it from restored sound state. A mixed-path render also drains/discards
armed capture streams so a later per-channel render cannot consume stale audio without advancing CPU.

## 4. Plugin ports

[DistrhoPluginInfo.h](../packages/native/plugin/DistrhoPluginInfo.h) declares 16 outputs.
[PluginDSP.cpp](../packages/native/plugin/PluginDSP.cpp) derives eight stereo port groups from that count:
`Out 1` … `Out 8`, symbols `out_1_l/r` … `out_8_l/r`. Names remain generic because the same ports serve
GB, NES, pins and per-system routing. Channel mode uses individual mono lanes inside those pairs.

## 5. CLI and background rendering

`renderAudioPerChannel(id, ms)` allocates its stream buffers from the active system's layout and returns
one interleaved L/R buffer per stream. For a mono NES stream, only L carries audio.

The shared [render library](../packages/retroplug/src/render/render.ts) used by CLI and background UI
rendering writes one WAV per stream. `--split channels` writes the five base NES files followed by
mapper-specific names such as `vrc6_saw`, `vrc7_fm6`, `n163_wave8` and `mmc5_pcm`.
`--split pins` writes `pulse`, `tnd` and `expansion`. GB channel files remain stereo; NES files are mono.
The rename collision policy checks expansion filenames as well as base filenames.

The `export-nes-mono` example deliberately selects just the first five base voices; the normal render
command includes every expansion voice. WAV export uses the actual host sample rate and 16-bit PCM.

## 6. Verification

- `retroplug-audio-test`: real Engine routing above output eight, narrow-host fallback, live switching,
  sample-rate changes, savestate restore, synthetic FDS wave isolation and existing pin reconstruction.
- `test-native/expansion-stems.test.ts`: committed VRC6/VRC7/MMC5/N163/5B ROMs driven by MIDI;
  expansion isolation and live volume muting.
- `test-native/expansion-register-stems.test.ts`: synthetic carts executing real register writes;
  every VRC6/VRC7/N163/5B voice and MMC5's two pulses plus PCM edge independently.
- `test-native/render-expansion-stems.test.ts`: real VRC7 stem files and collision avoidance when only
  an expansion filename is occupied.
- `test-ui/audio-device.test.ts`: the standalone can select and apply 16 output channels.

A plugin port inspection verifies the actual compiled format's layout. A saved-session restore in a
real DAW, listening and physical multichannel-device checks are separate evidence.

## 7. Remaining scope

EPSM uses a separate audio-provider path outside these mixer channels, and NSF can combine multiple
expansion chips. Neither fits the single-mapper voice layout described here. Their output allocation,
including any need for more than 16 outputs, remains a separate design task. Dynamic DAW port labels
and stereo pairs for every NES voice are also deferred; Stereo Pins provides paired pin outputs.
