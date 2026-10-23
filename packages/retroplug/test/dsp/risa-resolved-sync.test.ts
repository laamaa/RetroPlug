import { test, expect } from "../../testing/harness";
import { DspKernel, CollectingSink, type BlockInput } from "../../src/dspKernel";
import { RoleRegistry } from "../../src/systemRoles";
import { registerDspRoles } from "../../src/dspRoles";
import { risaResolvedArm } from "../../src/risa/seek";

class Sink extends CollectingSink {
  requests: { system: number; token: number; clock: number }[] = [];
  ram = new Map<number, number>([[10, 0], [11, 8]]);
  readRamByte(_system: number, address: number): number | undefined { return this.ram.get(address); }
  requestRisaSeek(system: number, token: number, clock: number): void {
    this.requests.push({ system, token, clock });
  }
}
function setup(prepared = false) {
  const registry = new RoleRegistry();
  registerDspRoles(registry);
  const sink = new Sink();
  const kernel = new DspKernel(registry, sink);
  kernel.setSystems({ systems: [{ id: 1, pipeline: [{ kind: "risa-sync", config: { resolvedSeek: true, ...(prepared ? { prepareAddress: 10, generationAddress: 11 } : {}) } }] }] });
  return { kernel, sink };
}
const block = (clock: number): BlockInput => ({ frames: 1000, sampleRate: 48000, tempo: 120,
  ppqStart: clock / 24, transport: true, midiIn: [], buttons: [], keys: [], serialOut: [] });
const packet = risaResolvedArm([null, null, null, null, null]);

test("resolved start gates playback and requests fresh song calculation", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(192));
  expect(sink.sinks.coreBytes).toEqual([{ system: 1, frame: 0, data: [0xfc], flush: true }]);
  expect(sink.requests).toEqual([{ system: 1, token: 1, clock: 192 }]);
});
test("prepared result primes once and explicitly catches up elapsed clocks", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(192));
  kernel.processBlock({ ...block(193), seekResults: [{ system: 1, token: 1, clock: 192, ok: true, packet }] });
  expect(sink.sinks.coreBytes.map((p) => p.data)).toEqual([packet, [0xfa], [0xf8]]);
  expect(sink.sinks.coreBytes[0].flush).toBe(true);
  kernel.processBlock(block(194));
  expect(sink.sinks.coreBytes.map((p) => p.data)).toEqual([[0xf8]]);
});
test("new loop generation rejects the previous worker result", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(192));
  kernel.processBlock({ ...block(0), seekResults: [{ system: 1, token: 1, clock: 192, ok: true, packet }] });
  expect(sink.requests[1]).toEqual({ system: 1, token: 2, clock: 0 });
  expect(sink.sinks.coreBytes.map((p) => p.data)).toEqual([[0xfc]]);
});
test("old or failed results request current time without a huge replay burst", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(96));
  kernel.processBlock({ ...block(97), seekResults: [{ system: 1, token: 1, clock: 0, ok: true, packet }] });
  expect(sink.sinks.coreBytes.length).toBe(0);
  expect(sink.requests[1].clock).toBe(97);
});
test("core replacement forces a fresh seek on a continuous host timeline", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(0));
  kernel.processBlock({ ...block(1), seekResults: [{ system: 1, token: 0, clock: 0, ok: false, packet: [] }] });
  expect(sink.requests[1]).toEqual({ system: 1, token: 2, clock: 1 });
});

test("negative DAW preroll sends no song clocks before clock zero", () => {
  const { kernel, sink } = setup();
  kernel.processBlock(block(-24));
  expect(sink.requests.length).toBe(0);
  kernel.processBlock(block(-23));
  expect(sink.sinks.coreBytes.length).toBe(0);
});

test("prepared start waits for THIS generation and preserves the original target clock", () => {
  const {kernel, sink} = setup(true);
  kernel.processBlock(block(192));
  kernel.processBlock({...block(193), seekResults: [{system:1,token:1,clock:192,ok:true,packet}]});
  expect(sink.sinks.coreBytes.map(p=>p.data)).toEqual([packet]);
  sink.ram.set(10,5); // an old ready flag is insufficient
  kernel.processBlock(block(194));
  expect(sink.sinks.coreBytes.length).toBe(0);
  sink.ram.set(11,9);
  kernel.processBlock(block(195));
  expect(sink.sinks.coreBytes).toEqual([
    {system:1,frame:1800,data:[0xfa]},
    {system:1,frame:2800,data:[0xf8]},
    {system:1,frame:3800,data:[0xf8]},
    {system:1,frame:4800,data:[0xf8]},
  ]);
});

test("late preparation keeps the first row instead of bursting past it", () => {
  const {kernel, sink} = setup(true);
  kernel.processBlock(block(0));
  kernel.processBlock({...block(1), seekResults:[{system:1,token:1,clock:0,ok:true,packet}]});
  for(let clock=2;clock<7;clock++)kernel.processBlock(block(clock));
  sink.ram.set(10,5);sink.ram.set(11,9);
  kernel.processBlock(block(7));
  expect(sink.sinks.coreBytes[0]).toEqual({system:1,frame:0,data:[0xfa]});
  expect(sink.sinks.coreBytes[1]).toEqual({system:1,frame:1000,data:[0xf8]});
});

test("prepared clocks keep sample timestamps when tempo changes", () => {
  const {kernel, sink} = setup(true);
  kernel.processBlock(block(0));
  kernel.processBlock({...block(1), seekResults:[{system:1,token:1,clock:0,ok:true,packet}]});
  sink.ram.set(10,5);sink.ram.set(11,9);
  kernel.processBlock({...block(2),tempo:240});
  expect(sink.sinks.coreBytes.map(p=>p.frame)).toEqual([2800,3800,4800,5300]);
  kernel.processBlock({...block(4),tempo:240,transport:false});
  expect(sink.sinks.coreBytes).toEqual([{system:1,frame:4800,data:[0xfc]}]);
});

test("stopped warm-up does not arm or take ownership of the ROM", () => {
  const {kernel,sink}=setup(true);
  kernel.processBlock({...block(192),transport:false});
  expect(sink.sinks.coreBytes.length).toBe(0);
  expect(sink.requests).toEqual([{system:1,token:0xffffffff,clock:192}]);
  kernel.processBlock({...block(192),transport:false,seekResults:[{system:1,token:0xffffffff,clock:192,ok:true,packet}]});
  expect(sink.requests.length).toBe(1);
  kernel.processBlock(block(192));
  expect(sink.requests[1]).toEqual({system:1,token:1,clock:192}); // fresh bytes at Play
});

test("REAPER sample rounding at a bar boundary primes the intended clock", () => {
 const {kernel,sink}=setup(true);
 kernel.processBlock({...block(768),ppqStart:31.999955,tempo:145,sampleRate:44100});
 expect(sink.requests[0].clock).toBe(768);
 const second=setup(true);
 second.kernel.processBlock({...block(768),ppqStart:32-0.01,tempo:145,sampleRate:44100});
 expect(second.sink.requests[0].clock).toBe(767); // a real position before the bar
});

test("core replacement invalidates stopped warm-up at the same cursor", () => {
  const { kernel, sink } = setup(true);
  kernel.processBlock({ ...block(192), transport: false });
  kernel.processBlock({ ...block(192), transport: false,
    seekResults: [{ system: 1, token: 0xffffffff, clock: 192, ok: true, packet }] });
  expect(sink.requests.length).toBe(1);
  kernel.processBlock({ ...block(192), transport: false,
    seekResults: [{ system: 1, token: 0, clock: 0, ok: false, packet: [] }] });
  expect(sink.requests[1]).toEqual({ system: 1, token: 0xffffffff, clock: 192 });
});
