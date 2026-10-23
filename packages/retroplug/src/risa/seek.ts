// Cold host-side transport model for Risa's live working image. No audio state
// is simulated. Build after a coherent song snapshot changes; locate() only
// performs a modulo and binary search, including for looping songs.
import {
  BANK_DATA, BANK_PHRASES_HI, WRAM_BANK_SIZE, WORKING_SIZE,
  SONG_OFFSET, CHAIN_OFFSET, GROOVE_OFFSET, SAVE_MAGIC_OFFSET, SAVE_MAGIC_VER, SAVE_MAGIC,
  SONG_ROWS, CHAIN_ROWS, CHAIN_SIZE, PHRASE_ROWS, PHRASE_SIZE, PHRASE_COUNT,
  GROOVE_SIZE, GROOVE_COUNT, INST_COUNT, SEQ_TRACK_COUNT, INST_EMPTY,
} from "./codec/constants";

const EMPTY = INST_EMPTY; // phrase/chain empty and unvisited HOP use the same byte
const FX_GRV = 7;
const FX_HOP = 8;
const DATA = BANK_DATA * WRAM_BANK_SIZE;

/** Resolved sounding row, AFTER its bounded HOP redirects but BEFORE note/G
 * processing. The ROM primes this row without chasing H again. Countdown
 * replaces the row's freshly loaded groove duration. Audio history is omitted. */
export interface RisaSeekTrack {
  songRow: number;
  chainRow: number;
  phraseRow: number;
  grooveIndex: number;
  groovePosition: number;
  hopRemaining: number;
  hopJumped: boolean;
  instrument: number;
  countdown: number;
}

interface Cursor extends Omit<RisaSeekTrack, "countdown"> {
  chain: number;
  phrase: number;
}
interface Event {
  clock: number;
  duration: number;
  rawDuration: number;
  state: Omit<RisaSeekTrack, "countdown">;
}
export interface RisaSeekTimeline {
  tracks: { events: Event[]; endClock: number; loopClock: number | null }[];
}

function chainAt(w: Uint8Array, track: number, row: number): number {
  return w[DATA + SONG_OFFSET + track * SONG_ROWS + row];
}
function phraseAt(w: Uint8Array, chain: number, row: number): number {
  return w[DATA + CHAIN_OFFSET + chain * CHAIN_SIZE + row * 2];
}
function playable(w: Uint8Array, track: number, row: number): number {
  const chain = chainAt(w, track, row);
  return chain === EMPTY || phraseAt(w, chain, 0) === EMPTY ? EMPTY : chain;
}
function phraseOffset(c: Cursor): number {
  return (c.phrase & 0x80 ? BANK_PHRASES_HI * WRAM_BANK_SIZE : 0)
    + (c.phrase & 0x7f) * PHRASE_SIZE + c.phraseRow * 4;
}

// seq_advance_chain.s / seq_advance_song.s: end at the first empty chain
// step, advance within this track's contiguous island, wrap to its top.
function advanceChain(w: Uint8Array, track: number, c: Cursor): boolean {
  c.chainRow++;
  if (c.chainRow < CHAIN_ROWS && phraseAt(w, c.chain, c.chainRow) !== EMPTY) {
    c.phrase = phraseAt(w, c.chain, c.chainRow);
    return true;
  }
  c.chainRow = 0;
  let row = c.songRow + 1;
  let chain = row < SONG_ROWS ? playable(w, track, row) : EMPTY;
  if (chain === EMPTY) {
    row = c.songRow;
    while (row > 0 && playable(w, track, row - 1) !== EMPTY) row--;
    chain = playable(w, track, row);
  }
  if (chain === EMPTY) return false;
  c.songRow = row;
  c.chain = chain;
  c.hopRemaining = EMPTY;
  c.phrase = phraseAt(w, chain, 0);
  return true;
}

function rowEvent(w: Uint8Array, track: number, c: Cursor): { rawDuration: number; state: Event["state"] } | null {
  let p = phraseOffset(c);
  let jumped = false;
  // seq_hop_resolve.s is bounded to sixteen redirects, even for H0y cycles.
  if (w[p + 2] === FX_HOP) {
    for (let left = 16; left > 0; left--) {
      const value = w[p + 3];
      if (value === EMPTY) return null; // HFF, stop THIS track
      if (value < 16) {
        if (!advanceChain(w, track, c)) return null;
        c.hopRemaining = EMPTY;
      } else {
        if (c.hopRemaining === EMPTY) c.hopRemaining = value >> 4;
        if (c.hopRemaining === 0) {
          c.hopRemaining = EMPTY;
          break;
        }
        c.hopRemaining--;
      }
      c.phraseRow = value & 15;
      jumped = true;
      p = phraseOffset(c);
      if (w[p + 2] !== FX_HOP) break;
    }
  }
  c.hopJumped = jumped;
  const state = snapshot(c);
  c.hopJumped = false;
  if (w[p + 1] < INST_COUNT) c.instrument = w[p + 1];
  if (w[p + 2] === FX_GRV) c.grooveIndex = w[p + 3] & (GROOVE_COUNT - 1);
  // Match the live sequencer's order exactly. In particular Gxx preserves
  // the old groove position, even if it exceeds the new groove's length.
  const g = DATA + GROOVE_OFFSET + c.grooveIndex * GROOVE_SIZE;
  const rawDuration = w[g + 1 + c.groovePosition];
  c.groovePosition++;
  if (c.groovePosition >= w[g]) c.groovePosition = 0;
  c.phraseRow++;
  if (c.phraseRow >= PHRASE_ROWS) {
    c.phraseRow = 0;
    if (!jumped) c.hopRemaining = EMPTY;
    if (!advanceChain(w, track, c)) return null;
  }
  return { rawDuration, state };
}

function cursorKey(c: Cursor): string {
  return `${c.songRow},${c.chainRow},${c.phraseRow},${c.grooveIndex},${c.groovePosition},${c.hopRemaining},${c.instrument}`;
}
function snapshot(c: Cursor): Omit<RisaSeekTrack, "countdown"> {
  return {
    songRow: c.songRow, chainRow: c.chainRow, phraseRow: c.phraseRow,
    grooveIndex: c.grooveIndex, groovePosition: c.groovePosition,
    hopRemaining: c.hopRemaining, hopJumped: c.hopJumped, instrument: c.instrument,
  };
}

/** Build once per song revision, OUTSIDE the realtime audio callback. The
 * cap bounds hostile/very complex songs; an exceeded cap is an explicit
 * preparation failure, never a fallback to a made-up structural address. */
export function buildRisaSeekTimeline(w: Uint8Array, eventLimit = 262144): RisaSeekTimeline {
  if (w.length < WORKING_SIZE ||
      SAVE_MAGIC.some((byte, i) => w[DATA + SAVE_MAGIC_OFFSET + i] !== byte) ||
      w[DATA + SAVE_MAGIC_OFFSET + 3] !== SAVE_MAGIC_VER) {
    throw new Error("Risa seek requires a current, initialized working-song image");
  }
  const tracks: RisaSeekTimeline["tracks"] = [];
  for (let track = 0; track < SEQ_TRACK_COUNT; track++) {
    const events: Event[] = [];
    let clock = 0;
    let loopClock: number | null = null;
    const chain = playable(w, track, 0);
    if (chain !== EMPTY) {
      const c: Cursor = {
        chain, phrase: phraseAt(w, chain, 0), songRow: 0, chainRow: 0, phraseRow: 0,
        grooveIndex: 0, groovePosition: 0, hopRemaining: EMPTY, hopJumped: false, instrument: EMPTY,
      };
      const seen = new Map<string, number>();
      for (;;) {
        const key = cursorKey(c);
        const repeat = seen.get(key);
        if (repeat !== undefined) { loopClock = repeat; break; }
        if (events.length >= eventLimit) throw new Error(`Risa seek event limit on track ${track}`);
        seen.set(key, clock);
        const event = rowEvent(w, track, c);
        if (event === null) break;
        const { rawDuration, state } = event;
        // A groove step of zero leaves frame_ctr zero; the next tick still
        // processes another row, so it takes one clock rather than zero.
        const duration = Math.max(1, rawDuration);
        events.push({ clock, duration, rawDuration, state });
        clock += duration;
      }
    }
    tracks.push({ events, endClock: clock, loopClock });
  }
  return { tracks };
}

/** O(log rows), independent of distance into the song. null means this track
 * has stopped by the target time. Clock zero is the initial priming tick. */
export function locateRisaClock(timeline: RisaSeekTimeline, absoluteClock: number): (RisaSeekTrack | null)[] {
  if (!Number.isSafeInteger(absoluteClock) || absoluteClock < 0) throw new Error("Invalid Risa clock");
  return timeline.tracks.map((track) => {
    let clock = absoluteClock;
    if (clock >= track.endClock) {
      if (track.loopClock === null) return null;
      clock = track.loopClock + (clock - track.loopClock) % (track.endClock - track.loopClock);
    }
    let lo = 0, hi = track.events.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (track.events[mid].clock <= clock) lo = mid;
      else hi = mid;
    }
    const event = track.events[lo];
    return { ...event.state, countdown: event.rawDuration === 0 ? 0 : event.duration - (clock - event.clock) };
  });
}

/** RSEEK1 capability: F9 53, active mask, five fixed nine-byte track records.
 * The caller follows this barrier packet with FA and clocks AFTER the target.
 * All payload bytes are seven-bit clean; zero countdown is a legal groove. */
export function risaResolvedArm(tracks: readonly (RisaSeekTrack | null)[]): number[] {
  if (tracks.length !== SEQ_TRACK_COUNT) throw new Error("Risa seek needs five tracks");
  let mask = 0;
  const out = [0xf9, 0x53, 0];
  for (let i = 0; i < SEQ_TRACK_COUNT; i++) {
    const t = tracks[i];
    if (!t) { out.push(0, 0, 0, 0, 0, 16, 0, 0, 64); continue; }
    mask |= 1 << i;
    const hop = t.hopRemaining === EMPTY ? 16 : t.hopRemaining;
    const inst = t.instrument === EMPTY ? 64 : t.instrument;
    const values = [t.songRow, t.chainRow, t.phraseRow, t.grooveIndex, t.groovePosition | (t.hopJumped ? 16 : 0),
      hop, t.countdown & 127, t.countdown >> 7, inst];
    const limits = [128, 16, 16, 16, 32, 17, 128, 2, 65];
    if (values.some((v, j) => !Number.isInteger(v) || v < 0 || v >= limits[j]) ||
        !Number.isInteger(t.countdown) || t.countdown < 0 || t.countdown > 255) {
      throw new Error("Invalid resolved Risa track");
    }
    out.push(...values);
  }
  out[2] = mask;
  return out;
}

/** Exact comparison of the regions used by the resolver. Volatile scratch
 * changes during playback and must never invalidate a prepared timeline. */
export function sameRisaSeekSong(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < WORKING_SIZE || b.length < WORKING_SIZE) return false;
  for (const [start, length] of [
    [0, WRAM_BANK_SIZE],
    [BANK_PHRASES_HI * WRAM_BANK_SIZE, (PHRASE_COUNT - 128) * PHRASE_SIZE],
    [DATA, GROOVE_OFFSET + GROOVE_COUNT * GROOVE_SIZE],
    [DATA + SAVE_MAGIC_OFFSET, SAVE_MAGIC.length + 1 + 4],
  ]) {
    for (let i = start; i < start + length; i++) if (a[i] !== b[i]) return false;
  }
  return true;
}
