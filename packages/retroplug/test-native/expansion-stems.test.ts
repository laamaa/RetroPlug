// Real mapper voices must reach independent Channels streams, including outputs above eight.
import { test, expect } from "../testing/harness";
import { bootSession } from "../cli/session";
import { syncDspFromStore } from "../src/appHost";
import { rms } from "./audio-levels-lib";

declare const __REPO_RESOURCES_DIR__: string;

for (const [chip, voices] of [["vrc6", 3], ["vrc7", 6], ["mmc5", 3], ["s5b", 3], ["n163", 8]] as const) {
  test(`${chip}: Channels includes isolated expansion voices after the five base stems`, () => {
    const s = bootSession();
    s.project.systems.adopt({
      romPath: `${__REPO_RESOURCES_DIR__}/roms/bliptoaster-${chip}.nes`,
      roles: [
        { kind: "nes-n8-midi", config: {} },
        { kind: "mesen", config: { channelExportMode: "individualMono" } },
      ],
    });
    syncDspFromStore(s.project, s.dsp);
    const id = s.project.systems.view()[0].id;
    try {
      s.audio.renderAudio(1200);
      s.audio.stageMidiIn([0xb5, 7, 127]);
      s.audio.renderAudio(100);
      s.audio.stageMidiIn([0x95, 69, 100]);
      s.audio.renderAudio(200);
      s.audio.stageMidiIn([0x95, 69, 100]);
      s.audio.renderAudio(200);
      const levels = s.audio.renderAudioPerChannel(id, 300).map(rms);
      console.log(`[${chip} stems] ${JSON.stringify(levels)}`);
      expect(levels.length).toBe(5 + voices);
      expect(Math.max(...levels.slice(5)), "expansion note reaches a stem").toBeGreaterThan(0.001);
      for (const level of levels.slice(0, 5)) expect(level, "base voices stay silent").toBeLessThan(0.00001);
      expect(levels.slice(5).filter((x) => x > 0.001).length, "one note lights one expansion voice").toBe(1);
      s.project.systems.setRoleConfig(id, "mesen", { expansionVolume: 0 });
      s.audio.renderAudio(100);
      expect(Math.max(...s.audio.renderAudioPerChannel(id, 100).map(rms)), "expansion volume mutes stems").toBeLessThan(0.00001);
    } finally {
      s.project.systems.removeSystem(id);
    }
  });
}
