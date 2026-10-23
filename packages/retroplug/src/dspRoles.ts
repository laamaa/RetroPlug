// The built-in DSP-thread role behaviors: doc-06 translators/sources authored as plain TS over the
// per-system context (dspKernel.ts). `mgb` + `lsdj-sync` are the two we're migrating off their
// legacy C++ roles; `midi-routing` is the project-scope behavior that fans host MIDI to systems,
// reusing the existing routeBlock decision. Registered into a RoleRegistry like registerCoreRoles.

import type { RoleRegistry, ConstructCaps } from "./systemRoles";
import type { ProjectBehavior, SystemBehavior, SystemCtx } from "./dspKernel";
import type { ConstructSpec } from "./backend";
import { z, clampedInt, boolField, enumField } from "./configSchema";
import { routeBlockInto, MidiRouting } from "./midiRouting";
import { LsdjSyncMode, LSDJ_MODE_VALUES, MIDI_ROUTING_VALUES } from "./settingsEnums";
import {
  KEYBOARD_NOTE_START,
  KEYBOARD_LOW_START,
  KEYBOARD_NOTE_MAP,
  KEYBOARD_LOW_OCTAVE_MAP,
  KEYBOARD_OCT_UP,
  KEYBOARD_OCT_DN,
  isExtendedScancode,
  toGbSerialByte,
} from "./lsdjKeyboardMap";
import { arduinoboyDecodeSerialOut, arduinoboyMasterSyncBlock, type ArduinoboyState, type MasterSyncState } from "./lsdjArduinoboy";
import { RISA_PPQN, RISA_START, RISA_CLOCK, RISA_STOP } from "./risaSync";
import { SMS_SYNC_PPQN, SMS_SYNC_COUNTER_MOD, syncLevelsFor, type SmsSyncMachine } from "./smsSync";
import { RISA_START_LATENCY_MS } from "./risa/startLatency";
import { registerControllerRole } from "./controllerRole";

// Forward every host-MIDI byte verbatim into the system's serial input. This is both `mgb`
// (== MgbPassthroughRole) and lsdj-sync's MidiPassthrough mode (== LsdjSyncRole handlePassthrough).
const forwardMidiToSerial: SystemBehavior = (c) => {
  // Indexed loops, not `.forEach` — the nested forEach allocated a closure per call + one per event,
  // and this is the hot mGB path (spec/08-profiling.md).
  const midi = c.midi;
  for (let i = 0; i < midi.length; i++) {
    const e = midi[i];
    const data = e.data;
    for (let j = 0; j < data.length; j++) c.pushSerialIn(e.frame, data[j]);
  }
};
const mgb = forwardMidiToSerial;

// Forward every routed host-MIDI message straight to the core's onMidi (the emitCoreMidi sink). The
// NES twin of `mgb`: a core with no serial port (Mesen) receives MIDI here instead of over serial.
// The whole message goes as one event — the native NesN8MidiRole iterates the bytes into its FIFO.
const forwardMidiToCore: SystemBehavior = (c) => {
  const midi = c.midi;
  for (let i = 0; i < midi.length; i++) {
    const e = midi[i];
    c.emitCoreMidi(e.frame, e.data);
  }
};

// LSDj serial control bytes (host → LSDj over the link cable) and MIDI status helpers, mirroring
// LsdjSyncRole.cpp. DPF hands the full status byte (channel in the low nibble) in data[0].
const START_BTN = 7; // GameboyButton::Start
const LSDJ_CLOCK = 0xf8; // 24-PPQN MIDI clock tick
const LSDJ_START = 0xfa; // transport start — Arduinoboy-mode bookend
const LSDJ_STOP = 0xfc; // transport stop
const MIDIMAP_NOTEOFF = 0xfe; // MidiMap NoteOff handshake sentinel
const MIDIMAP_CLOCK = 0xff; // MidiMap tick — Arduinoboy's Mode_LSDJ_Map setMapByte(0xFF) on a 0xF8
const isNoteOn = (status: number) => (status & 0xf0) === 0x90;
const isNoteOff = (status: number) => (status & 0xf0) === 0x80;
const channelOf = (status: number) => status & 0x0f;
// MidiMap row byte: ch0 NoteOn → note; ch1 → note + 128; other channels skipped (-1). Exported so the
// controller layer's launch ENCODER (src/controller/trackerTarget.ts) can be round-tripped against the
// decoder that actually ships, rather than restating the same convention twice and hoping they agree.
export const midiMapRow = (channel: number, note: number) => (channel === 0 ? note : channel === 1 ? note + 128 : -1);

// MidiSyncArduinoboy (== LsdjSyncRole MidiSyncArduinoboy). Input notes drive runtime state: 24/25 toggle
// the play flag, 26-29 set the tempo divisor, 30+ push a raw row byte (note-30). The 0xF8 clock flows
// only while the play flag is set (NOT on host transport), and 0xFA/0xFC bookend host-transport edges.
const arduinoboy: SystemBehavior = (c) => {
  const st = c.state as { playing?: boolean; divisor?: number; prevTransport?: boolean; armDown?: number };
  if (st.divisor === undefined) st.divisor = (c.config.tempoDivisor as number) || 1;
  // autoStart: tap START on the host transport rise to park the SYNC=Lsdj cart in "wait for sync" before
  // the note-24 play-enable + clock arrive — so a headless render starts on-grid instead of boot-lagging.
  if (c.config.autoStart) {
    if (c.block.transport && !(st.prevTransport ?? false)) { c.pressButton(START_BTN, true); st.armDown = 2; }
    else if (st.armDown && st.armDown > 0) { if (--st.armDown === 0) c.pressButton(START_BTN, false); }
  }
  for (const e of c.midi) {
    if (!isNoteOn(e.data[0])) continue;
    const note = e.data[1];
    if (note === 24) st.playing = true;
    else if (note === 25) st.playing = false;
    else if (note === 26) st.divisor = 1;
    else if (note === 27) st.divisor = 2;
    else if (note === 28) st.divisor = 4;
    else if (note === 29) st.divisor = 8;
    else if (note >= 30) c.pushSerialIn(e.frame, note - 30);
  }
  if (c.block.transport !== (st.prevTransport ?? false)) {
    c.pushSerialIn(0, c.block.transport ? LSDJ_START : LSDJ_STOP);
    st.prevTransport = c.block.transport;
  }
  // Deliver each clock opportunistically (frame 0), NOT at its tick sample-offset. LSDj in Arduinoboy-slave
  // mode toggles its serial-clock-enable (SC) between bytes, so the SameBoy offset gate — which holds a byte
  // until its sample offset — misses LSDj's ready window and starves the clock (LSDj goes silent). eachTick
  // still emits the tempo-correct NUMBER of clocks per block; only the intra-block delivery time is dropped
  // (it was cosmetic before the host-MIDI offset gate landed). Host MIDI (forwardMidiToSerial) keeps its
  // real frame for sample-accuracy — that path drives always-listening ROMs like mGB.
  if (st.playing) c.eachTick(24 / (st.divisor || 1), () => c.pushSerialIn(0, LSDJ_CLOCK));
};

// MidiMap (== LsdjSyncRole handleMidiMap): NoteOn → a row byte LSDj reads as a SONG-row jump; a matching
// NoteOff sends the 0xFE handshake. lastRow persists across blocks so the NoteOff only fires for the row
// most recently sounded.
//
// MI.MAP is a SYNC mode, so it also has to CLOCK the cart: Arduinoboy's Mode_LSDJ_Map turns each host
// 0xF8 into a 0xFF byte on the link, and LSDj advances one phrase step per 6 of them. Without that
// stream a mapped row triggers, sounds its first step, and then freezes there forever — measured on a
// real cart in test-native/lsdj-playback-probe.test.ts (B1), which is how this omission was found.
// Transport-gated for free: walkTicks yields nothing while the host is stopped, so a paused DAW leaves
// the cart exactly as it was.
const midiMap: SystemBehavior = (c) => {
  const st = c.state as { lastRow?: number };
  if (st.lastRow === undefined) st.lastRow = -1;
  for (const e of c.midi) {
    const status = e.data[0];
    const note = e.data.length >= 2 ? e.data[1] : 0;
    if (isNoteOn(status)) {
      const row = midiMapRow(channelOf(status), note);
      if (row < 0) continue;
      c.pushSerialIn(e.frame, row & 0xff);
      st.lastRow = row;
    } else if (isNoteOff(status)) {
      if (midiMapRow(channelOf(status), note) === st.lastRow) {
        c.pushSerialIn(e.frame, MIDIMAP_NOTEOFF);
        st.lastRow = -1;
      }
    }
  }
  // Frame 0, NOT the tick's sample offset — the same rule the Arduinoboy mode above follows, and for
  // the same reason: LSDj toggles its serial-clock-enable between bytes in the aboy slave protocols,
  // so a byte held back by SameBoy's offset gate misses the cart's ready window and the clock starves
  // (the cart then ignores row bytes too, and sits silent). Delivering at frame 0 emits the same NUMBER
  // of clocks per block and only drops intra-block placement, which this protocol does not carry anyway.
  const divisor = (c.config.tempoDivisor as number) || 1;
  c.eachTick(24 / divisor, () => c.pushSerialIn(0, MIDIMAP_CLOCK));
};

// Slide LSDj's internal keyboard octave toward `target` by emitting OCT_UP/OCT_DN scancodes; returns the
// new octave. Mirrors slideKeyboardOctave in LsdjSyncRole.cpp.
function slideKeyboardOctave(c: SystemCtx, frame: number, target: number, current: number): number {
  if (target === current) return current;
  const code = toGbSerialByte(target > current ? KEYBOARD_OCT_UP : KEYBOARD_OCT_DN);
  let steps = Math.abs(target - current);
  while (steps-- > 0) c.pushSerialIn(frame, code);
  return target;
}

// KeyboardMidi (== LsdjSyncRole handleKeyboardMidi): translate MIDI NoteOns into LSDj PS/2 scancodes,
// sliding the octave cursor to track the incoming note. octave persists across blocks.
const keyboardMidi: SystemBehavior = (c) => {
  const st = c.state as { octave?: number };
  if (st.octave === undefined) st.octave = 4;
  for (const e of c.midi) {
    if (!isNoteOn(e.data[0])) continue;
    let note = e.data[1];
    if (note >= KEYBOARD_NOTE_START) {
      note -= KEYBOARD_NOTE_START;
      st.octave = slideKeyboardOctave(c, e.frame, Math.floor(note / 12), st.octave);
      const idx = note >= 0x3c ? (note % 12) + 0x0c : note % 12; // two rows of note keys
      c.pushSerialIn(e.frame, toGbSerialByte(KEYBOARD_NOTE_MAP[idx]));
    } else if (note >= KEYBOARD_LOW_START) {
      const command = KEYBOARD_LOW_OCTAVE_MAP[note - KEYBOARD_LOW_START];
      // Cursor keys need the extended (0xE0) prefix; every byte is mangled to LSDj's GB-serial form.
      if (isExtendedScancode(command)) c.pushSerialIn(e.frame, toGbSerialByte(0xe0));
      c.pushSerialIn(e.frame, toGbSerialByte(command));
    }
  }
};

// ArduinoboyMaster / MIDIOUT (mode 7, == the native ArduinoboyMaster role): LSDj is a serial SLAVE that
// emits the Arduinoboy MI.OUT protocol on its serial-out port. Native captures the raw bytes and hands
// them back as ctx.serialOut (one-block latency); we strip the flag-gated framing + decode the byte
// protocol into host MIDI (emitMidiOut). Frame 0 — the protocol carries no intra-block timing, and the
// downstream drain/DAW timestamps by block. Decoder state (pending command, partial framing bits)
// persists across blocks in ctx.state.
const arduinoboyMaster: SystemBehavior = (c) => {
  if (c.serialOut.length === 0) return;
  const st = c.state as ArduinoboyState;
  arduinoboyDecodeSerialOut(c.serialOut, st, (data) => c.emitMidiOut(0, data));
};

// Master Sync (mode 8, == Arduinoboy firmware Mode 2, SYNC=LSDJ): LSDj self-clocks as the serial master
// and streams one byte per MIDI-clock tick out its link port; we turn each captured byte into a 0xF8
// clock (+ a song-row NoteOn/0xFA at run start, 0xFC on idle), so the host follows LSDj's tempo. Unlike
// mode 7 this runs EVERY block — an empty serial-out block is how the idle stop is detected.
const masterSync: SystemBehavior = (c) => {
  const st = c.state as MasterSyncState;
  arduinoboyMasterSyncBlock(c.serialOut, st, (data) => c.emitMidiOut(0, data));
};

// lsdj-sync: dispatch on the configured mode (LsdjSyncMode). Off(0)/Keyboard(4) emit nothing here — 4
// needs the host `keys` feed (a later phase). MidiSync's 0xF8 stream carries no 0xFA; the START-arm that
// begins LSDj is a user action, not part of the clock (only Arduinoboy mode bookends with 0xFA/0xFC).
const lsdjSync: SystemBehavior = (c) => {
  switch (c.config.mode as LsdjSyncMode) {
    case LsdjSyncMode.MidiSync: { // MidiSync
      // Optional auto-arm (autoStart): SYNC=MIDI LSDj only follows the clock once START has parked it in
      // "wait for MIDI" — normally a user action. When autoStart is set, tap START on the transport rise
      // (press ~2 blocks, then release) so LSDj starts with the host, the way a DAW user expects — and so
      // a headless DAW render (which can't press a joypad) can drive it. Off by default (manual arm).
      if (c.config.autoStart) {
        const st = c.state as { prevT?: boolean; armDown?: number };
        if (c.block.transport && !st.prevT) { c.pressButton(START_BTN, true); st.armDown = 2; }
        else if (st.armDown && st.armDown > 0) { if (--st.armDown === 0) c.pressButton(START_BTN, false); }
        st.prevT = c.block.transport;
      }
      const divisor = (c.config.tempoDivisor as number) || 1;
      c.eachTick(24 / divisor, (_t, off) => c.pushSerialIn(off, LSDJ_CLOCK));
      break;
    }
    case LsdjSyncMode.MidiSyncArduinoboy: arduinoboy(c); break;
    case LsdjSyncMode.MidiMap: midiMap(c); break;
    case LsdjSyncMode.KeyboardMidi: keyboardMidi(c); break;
    case LsdjSyncMode.MidiPassthrough: forwardMidiToSerial(c); break;
    case LsdjSyncMode.MidiOut: arduinoboyMaster(c); break; // ArduinoboyMaster / MIDIOUT
    case LsdjSyncMode.MasterSync: masterSync(c); break; // LSDj drives the host clock
    default: break; // Off / Keyboard emit nothing here
  }
};

// Only resolved-capable ROMs may be driven from the DAW. Stale project
// roles without that capability stay inert instead of guessing a position.
const RISA_SEEK_TOL = 1e-3;
const risaSync: SystemBehavior = (c) => {
  if (!c.config.resolvedSeek) return;
  if (c.config.prepareAddress !== undefined && c.config.generationAddress !== undefined)
    risaPreparedSync(c);
  else risaResolvedSync(c);
};

// One fixed look-ahead window covers worker preparation, FIFO delivery and
// the ROM's silent structural setup. Clock timestamps keep their host sample
// offsets, including through tempo changes. PDC reports this SAME delay.
const risaPreparedSync: SystemBehavior = (c) => {
  const b = c.block;
  const st = c.state as {
    prevT?: boolean; ppqEnd?: number; token?: number; clock?: number;
    elapsed?: number; delay?: number; extra?: number; packetSent?: boolean;
    generation?: number; started?: boolean; pending?: number[]; warmClock?: number;
  };
  const result = c.seekResult();
  if (result?.token === 0) {
    st.prevT = false;
    st.warmClock = undefined;
  }
  const seek = st.ppqEnd !== undefined && Math.abs(b.ppqStart - st.ppqEnd) > RISA_SEEK_TOL;
  const playing = b.transport && b.ppqStart >= 0;
  if (!playing) {
    // Build the cold timeline while stopped without taking ownership of the
    // ROM: previews/manual playback keep working. Start still captures fresh
    // bytes, so an edit after this warm-up cannot reuse a stale timeline.
    const warmClock = Math.floor(Math.max(0, b.ppqStart) * RISA_PPQN);
    if (result?.token === 0xffffffff && result.ok && result.clock === warmClock)
      st.warmClock = warmClock;
    if (st.warmClock !== warmClock) c.requestRisaSeek(0xffffffff, warmClock);
  }
  if (playing && (!st.prevT || seek)) {
    st.token = ((st.token ?? 0) + 1) >>> 0 || 1;
    if (st.token === 0xffffffff) st.token = 1; // reserved for stopped warm-up
    // REAPER positions use integer sample times. A nominal bar boundary can
    // be a couple of microseconds below its exact PPQ value; don't resolve
    // the previous row for that harmless rounding error.
    const clocks = b.ppqStart * RISA_PPQN;
    const nearest = Math.round(clocks);
    st.clock = Math.abs(clocks - nearest) <= RISA_PPQN * b.tempo / (b.sampleRate * 60)
      ? nearest : Math.floor(clocks);
    st.elapsed = 0;
    st.delay = Math.round(b.sampleRate * RISA_START_LATENCY_MS / 1000);
    st.extra = 0;
    st.packetSent = st.started = false;
    st.pending = [];
    c.setNextTick(st.clock + 1);
    c.pushCoreBytes(0, [RISA_STOP], true);
  } else if (!playing && st.prevT) {
    // Already queued clocks end at this same delayed stop edge.
    c.pushCoreBytes((st.delay ?? 0) + (st.extra ?? 0), [RISA_STOP]);
    st.started = false;
    st.pending = [];
  }
  if (playing) {
    if (!st.packetSent) {
      if (result && result.token === st.token && result.ok && result.clock === st.clock) {
        st.generation = c.readRamByte(c.config.generationAddress as number);
        c.pushCoreBytes(0, result.packet, true); // prepare WITHOUT triggering any row
        st.packetSent = true;
      } else c.requestRisaSeek(st.token!, st.clock!);
    }
    if (st.packetSent && !st.started &&
        c.readRamByte(c.config.generationAddress as number) !== st.generation &&
        c.readRamByte(c.config.prepareAddress as number) === 5) {
      // Never release FA before the new generation acknowledges its setup.
      // If preparation unusually exceeds the allowance, preserve the first
      // row's timing by shifting the whole stream; don't burst missed clocks.
      st.extra = Math.max(0, st.elapsed! - st.delay!);
      c.pushCoreBytes(Math.max(0, st.delay! - st.elapsed!), [RISA_START]);
      for (const due of st.pending!) c.pushCoreBytes(Math.max(0, due + st.extra - st.elapsed!), [RISA_CLOCK]);
      st.pending!.length = 0;
      st.started = true;
    }
    c.eachTick(RISA_PPQN, (_tick, off) => {
      if (st.started) c.pushCoreBytes(off + st.delay! + st.extra!, [RISA_CLOCK]);
      else if (st.pending!.length < 512) st.pending!.push(st.elapsed! + off + st.delay!);
      // Bound an indefinitely unready/malformed ROM. Restart from a fresh
      // host position instead of retaining unbounded timing history.
      // At the bound, prevT below requests a fresh transaction next block.
    });
    st.elapsed! += b.frames;
  }
  st.prevT = playing && (st.pending?.length ?? 0) < 512;
  st.ppqEnd = playing ? b.ppqStart + b.frames * b.tempo / (b.sampleRate * 60) : undefined;
};

// Resolved seeking uses the host worker's fresh live-memory snapshot. While
// preparing, gate the old playback and keep requesting the CURRENT clock. A
// completed result carries its exact clock; catch up the small worker/block
// delay explicitly, then resume the ordinary drift-free stream.
const risaResolvedSync: SystemBehavior = (c) => {
  const st = c.state as { prevT?: boolean; ppqEnd?: number; token?: number; waiting?: boolean; active?: boolean };
  const b = c.block;
  const result = c.seekResult();
  if (result?.token === 0) { st.prevT = false; st.active = false; }
  const seek = st.ppqEnd !== undefined && Math.abs(b.ppqStart - st.ppqEnd) > RISA_SEEK_TOL;
  if (b.transport && (!st.prevT || seek)) {
    st.token = ((st.token ?? 0) + 1) >>> 0 || 1;
    st.waiting = true;
    st.active = false;
    c.pushCoreBytes(0, [RISA_STOP], true);
  } else if (!b.transport && st.prevT) {
    c.pushCoreBytes(0, [RISA_STOP], true);
    st.active = false;
    st.waiting = false;
  }
  const clock = Math.floor(Math.max(0, b.ppqStart) * RISA_PPQN);
  if (b.transport && b.ppqStart >= 0 && st.waiting) {
    if (result && result.token === st.token && result.ok &&
        result.clock <= clock && clock - result.clock <= 24) {
      c.pushCoreBytes(0, result.packet, true);
      c.pushCoreBytes(0, [RISA_START]);
      for (let tick = result.clock + 1; tick <= clock; tick++) c.pushCoreBytes(0, [RISA_CLOCK]);
      c.setNextTick(clock + 1);
      st.waiting = false;
      st.active = true;
    } else {
      // A boot-in-progress snapshot can still lack the initialized magic;
      // retry rather than latching a permanent failure before the ROM boots.
      c.requestRisaSeek(st.token!, clock);
    }
  }
  if (b.transport && b.ppqStart >= 0 && st.active) c.eachTick(RISA_PPQN, (_tick, off) => c.pushCoreBytes(off, [RISA_CLOCK]));
  st.prevT = b.transport;
  st.ppqEnd = b.transport ? b.ppqStart + b.frames * b.tempo / (b.sampleRate * 60) : undefined;
};

// sms-sync: clock smsggdj from the DAW transport by driving a 2-bit counter onto its sync lines. The
// payload crossing ctx.pushCoreBytes is a LEVEL WORD, not a protocol byte - MesenSmsSystem routes it to
// SmsSyncRole, which holds it on the port until the next one. See smsSync.ts for the encoding and the
// ROM references.
//
// `machine` picks the wire format: "sms" (default) drives controller port 2's TR + TH, "gg" drives the
// EXT parallel port's PC4/PC5 + PC6. One role rather than two because the PROTOCOL is identical - same
// counter, same once-per-frame delta, same arm, same absence of a locate - and only the bit positions
// move. The provider sets it from the ROM's platform; the native side picks its own sink from the
// system it was built for, so this config drives the encoding alone.
//
// Much smaller than risaSync above, and every absence is the protocol's rather than a shortcut:
//
//   No arm, no flush. The ROM latches the live line state on its OWN Play and sits in WAIT until the
//   first host clock (engine.asm:383-388), so it self-synchronises and a stale level cannot count. A
//   held level has no undelivered-stream hazard either, so SmsSyncRole ignores the flush flag.
//
//   No start or stop message. Stop is implicit: stop clocking and the ROM's per-frame delta goes to 0.
//
//   No setNextTick and no seek detection, because there is nothing to relocate. The ROM sees only
//   deltas, so a DAW seek does NOT move the song - the transport drives tempo, start and stop but not
//   position. That is a genuine product difference from risa-sync and lsdj-sync, not an omission here.
//
// The counter is free-running and its absolute value is irrelevant (the ROM diffs it), so it is never
// reset - only advanced, one step per tick, at the tick's own sample offset.
const smsSync: SystemBehavior = (c) => {
  if (!c.block.transport) return;
  const st = c.state as { counter?: number };
  const levels = syncLevelsFor((c.config as { machine?: SmsSyncMachine }).machine ?? "sms");
  let counter = st.counter ?? 0;
  c.eachTick(SMS_SYNC_PPQN, (_t, off) => {
    counter = (counter + 1) % SMS_SYNC_COUNTER_MOD;
    c.pushCoreBytes(off, [levels(counter)]);
  });
  st.counter = counter;
};

// lsdj-sync load-time hook: a fresh LSDj cart with no SRAM runs a 12–15 s cartridge self-test on boot.
// When nothing else will seed the battery (no savestate, no sram blob, no on-disk .sav for native to
// load), hand it a valid empty sav — savFromJson stamps the jk/rb validity markers LSDj checks — so it
// boots straight to the song screen. Additive: return the spec untouched when real save data is present.
const lsdjSeedSav = (spec: ConstructSpec, caps: ConstructCaps): ConstructSpec => {
  const willLoadData = !!spec.stateBytes || !!spec.sramBytes || (spec.savPath != null && caps.fileExists(spec.savPath));
  if (willLoadData) return spec;
  return { ...spec, sramBytes: caps.savFromJson("{}") };
};

// midi-routing (project scope): fan the block's GLOBAL midiIn into the per-system inboxes the kernel
// then hands to each system's pipeline. `inboxes` are the kernel's persistent, pre-cleared arrays
// (positional, parallel to block.systems), filled in place with no per-block allocation.
const midiRouting: ProjectBehavior = (c) => {
  routeBlockInto(c.block.midiIn, (c.config.mode as MidiRouting) ?? MidiRouting.SendToAll, c.inboxes);
};

/** Register the built-in DSP-thread roles into `registry`. */
export function registerDspRoles(registry: RoleRegistry): void {
  registry.registerRole({ kind: "mgb", category: "feature", scope: "system", schema: z.object({}), dsp: mgb });
  // NES host-MIDI: forward routed MIDI to the core's onMidi (→ the always-attached N8 FIFO). Attached to
  // every NES ROM by the rom provider (romProviders.ts), mirroring the native always-on N8 role.
  registry.registerRole({ kind: "nes-n8-midi", category: "feature", scope: "system", schema: z.object({}), dsp: forwardMidiToCore });
  // risa-sync: ROM-derived capabilities select the N8-FIFO host transport (locate /
  // start / 24-PPQN clock / stop over pushCoreBytes). Attached only to sync-capable risa ROMs.
  registry.registerRole({ kind: "risa-sync", category: "feature", scope: "system", schema: z.object({ resolvedSeek: z.boolean().optional(), prepareAddress: z.number().int().min(0).max(2047).optional(), generationAddress: z.number().int().min(0).max(2047).optional() }), dsp: risaSync });
  // sms-sync: no config - clocks smsggdj by holding a 2-bit counter on controller port 2 (TR + TH) at
  // 24 PPQN. Attached only to smsggdj (the SMSGGDJ marker), NOT to every SMS ROM: these are Player 2's
  // button lines, so an unconditional attach would inject phantom P2 presses into any game.
  // `machine` is additive with a default, so no migration step: an existing project stamped before it
  // existed parses as "sms", which is what those projects were.
  registry.registerRole({
    kind: "sms-sync",
    category: "feature",
    scope: "system",
    schema: z.object({ machine: z.enum(["sms", "gg"]).default("sms") }),
    dsp: smsSync,
  });
  registry.registerRole({
    kind: "lsdj-sync",
    category: "feature",
    scope: "system",
    // mode: LsdjSyncMode ("off", "midiSync", … "midiOut", "masterSync"). tempoDivisor subdivides the
    // 24-PPQN clock (24/divisor) for MidiSync + MidiSyncArduinoboy; the menu offers 1/2/4/8. autoStart
    // taps START on the host transport rise to auto-arm a SYNC=MIDI (MidiSync) cart — needed for a
    // headless DAW render, off by default so normal MidiSync keeps its manual-arm behaviour.
    schema: z.object({ mode: enumField(LSDJ_MODE_VALUES, "midiSync"), tempoDivisor: clampedInt(1, 8, 1), autoStart: boolField(false) }),
    dsp: lsdjSync,
    onConstruct: lsdjSeedSav,
  });
  registry.registerRole({
    kind: "midi-routing",
    category: "feature",
    scope: "project",
    schema: z.object({ mode: enumField(MIDI_ROUTING_VALUES, "sendToAll") }),
    dsp: midiRouting,
  });
  // launchpad: the project-scope controller session (docs/launchpad-plan.md M5). Lives in its own file
  // because it pulls in the whole src/controller + src/launchpad layer, and is registered HERE so it
  // reaches the DSP bundle's registry rather than only the control plane's.
  registerControllerRole(registry);
}
