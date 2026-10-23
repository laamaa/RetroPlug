// Obsolete saved role configs must not resurrect fixed-grid Risa seeking.
import { test, expect } from "../../testing/harness";
import { RoleRegistry } from "../../src/systemRoles";
import { registerDspRoles } from "../../src/dspRoles";
import { DspKernel, CollectingSink, type BlockInput } from "../../src/dspKernel";

for (const config of [{}, { resolvedSeek: false }]) {
  test(`unsupported Risa role ${JSON.stringify(config)} emits no transport`, () => {
    const reg = new RoleRegistry();
    registerDspRoles(reg);
    let requests = 0;
    const sink = new CollectingSink();
    const kernel = new DspKernel(reg, Object.assign(sink, { requestRisaSeek: () => { requests++; } }));
    kernel.setSystems({ project: [], systems: [{ id: 1, pipeline: [{ kind: "risa-sync", config }] }] });
    for (const [transport, ppqStart] of [[false, 0], [true, 0], [true, 64], [false, 64]] as const) {
      const block: BlockInput = { frames: 22050, sampleRate: 44100, tempo: 120, ppqStart,
        transport, midiIn: [], buttons: [], keys: [], serialOut: [] };
      const out = kernel.processBlock(block);
      expect(out.coreBytes).toEqual([]);
      expect(requests).toBe(0);
    }
  });
}
