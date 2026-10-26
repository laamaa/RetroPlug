// Guards NES-in-plugin split routing end to end through the Engine: AudioRouting::PinSplit and
// AudioRouting::ChannelSplit over a REAL Mesen NES core, mono-packed one stream per output lane.
//
// The load-bearing thing here is the LIVE ARM. MesenNesSystem only reports per-channel streams once
// NesSoundMixer::SetChannelCapture has run, and that used to happen at construct only (from the "mesen"
// role's channelExportMode) — so selecting a split mode in the plugin would have silently rendered a
// plain stereo mix. Engine::syncSplitPlan arms the tap for the mode being entered without rebuilding the
// core (a routing flip must not reset a playing game), and restores what it found on the way out so the
// CLI / render path — which DOES set channelExportMode at construct and never selects a split routing —
// is left alone. Every assertion below is really about that: a non-silent lane 2 (Expansion) or lane 4
// (DMC) can only exist if the tap armed after construct.
//
// Lane arithmetic itself (stride, budget, gating) is EngineChannelSplit.test.cpp's fake-system job, and
// pin fidelity (Sum(pins) == the mix) is NesStems.test.cpp's; neither is re-litigated here.
//
// Drives bliptoaster with a ch1 note (-> APU Pulse1), which is the only way it makes sound.
//
// Run via `pnpm test:plugin`.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "host/engine/Engine.hpp"
#include "system/AudioRouting.hpp"
#include "system/SystemBase.hpp"
#include "system/DebugTarget.hpp"
#include "system/mesen/MesenNesConfig.hpp"
#include "system/mesen/MesenNesSystem.hpp"
#include "transport/MidiTypes.hpp"

#ifndef RP_BLIPTOASTER_ROM_PATH
#error "RP_BLIPTOASTER_ROM_PATH must be defined (path to resources/roms/bliptoaster.nes)"
#endif

namespace {

constexpr double        kSampleRate = 48000.0;
constexpr std::uint32_t kFrames     = 512;
constexpr int           kBootBlocks = 90;   // ~1 s: boot + FIFO init before the note takes
constexpr int           kPlayBlocks = 60;   // ~0.6 s of held note to measure

std::vector<std::uint8_t> readRom(const std::string& path) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    REQUIRE(f != nullptr);
    std::fseek(f, 0, SEEK_END);
    const long n = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    REQUIRE(n > 0);
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(n));
    REQUIRE(std::fread(bytes.data(), 1, bytes.size(), f) == bytes.size());
    std::fclose(f);
    return bytes;
}

// A booted NES, adopted the way a host adopts one: constructed with the DEFAULT (Mix) export mode, so
// anything per-channel the Engine later reports had to be armed live.
std::unique_ptr<MesenNesSystem> buildNes(SystemId id, const std::string& path = RP_BLIPTOASTER_ROM_PATH) {
    MesenNesConfig cfg;
    cfg.romPath = path;
    auto sys = std::make_unique<MesenNesSystem>(id, cfg, readRom(path));
    sys->onActivate(kSampleRate);
    REQUIRE(sys->activated());
    REQUIRE(sys->channelExportMode() == 0);  // constructed as a plain Mix system
    return sys;
}

::MidiEvent noteOnCh1() {
    ::MidiEvent e{};
    e.frame   = 0;
    e.size    = 3;
    e.data[0] = 0x90;  // NoteOn, channel 1
    e.data[1] = 60;    // C4
    e.data[2] = 100;   // velocity
    return e;
}

// Eight output lanes plus the readouts the checks are phrased in: each lane's peak magnitude, and the
// biggest sample-level divergence within each stereo PAIR (0 => the pair's two lanes are identical,
// which is what "the mono stem was mirrored across the pair" means).
struct Lanes {
    std::array<std::vector<float>, 16> buf;
    std::array<float*, 16>             ptr{};
    std::array<float, 16>              peak{};
    std::array<float, 8>              pairDiff{};

    Lanes() {
        for (std::size_t i = 0; i < buf.size(); ++i) {
            buf[i].assign(kFrames, 0.0f);
            ptr[i] = buf[i].data();
        }
    }
    void resetPeaks() { peak.fill(0.0f); pairDiff.fill(0.0f); }
    void accumulatePeaks() {
        for (std::size_t L = 0; L < buf.size(); ++L)
            for (float x : buf[L]) peak[L] = std::max(peak[L], std::abs(x));
        for (std::size_t p = 0; p < pairDiff.size(); ++p)
            for (std::uint32_t i = 0; i < kFrames; ++i)
                pairDiff[p] = std::max(pairDiff[p], std::abs(buf[2 * p][i] - buf[2 * p + 1][i]));
    }
};

// Boot the core, then hold a note for kPlayBlocks, tracking each lane's peak over the held section only.
// The note is re-sent periodically so the measurement doesn't hinge on the ROM sustaining, and primed
// near the end of boot because bliptoaster drops its first MIDI message.
void driveAndMeasure(Engine& eng, SystemId id, Lanes& lanes, std::size_t numOutputs, std::uint8_t channel = 0) {
    SystemBase* sys = eng.findSystem(id);
    REQUIRE(sys != nullptr);
    ::MidiEvent note = noteOnCh1();
    note.data[0] |= channel;

    for (int b = 0; b < kBootBlocks; ++b) {
        if (b >= kBootBlocks - 2) sys->onMidi(&note, 1);
        eng.processBlock(kFrames, lanes.ptr.data(), numOutputs);
    }
    lanes.resetPeaks();
    for (int b = 0; b < kPlayBlocks; ++b) {
        if (b % 20 == 0) sys->onMidi(&note, 1);
        eng.processBlock(kFrames, lanes.ptr.data(), numOutputs);  // processBlock zeroes the lanes itself
        lanes.accumulatePeaks();
    }
}

constexpr float kSignal = 1.0e-4f;  // "this lane carried audio"; a routed NES stem is orders above it

} // namespace

TEST_CASE("Engine PinSplit arms a real NES tap live and fans 3 mono pins across outs 0..2",
          "[audio][channelsplit][nes]") {
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    eng.setAudioRouting(AudioRouting::PinSplit);

    // The arm happened on the routing change, against an already-booted core — no rebuild, no reset.
    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);
    CHECK(nes->channelExportMode() == 1);           // StereoModPins
    CHECK(nes->channelLayout().size() == 3);        // Pulse | TND | Expansion

    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 8);

    // Pulse carries the note. TND and Expansion are present as lanes whatever they contain — the real
    // claim is the negative one below, that nothing spilled past the three pins.
    CHECK(lanes.peak[0] > kSignal);
    for (int L = 3; L < 8; ++L)
        CHECK(lanes.peak[L] == 0.0f);
    // Pin 2 (TND) sits on the RIGHT of the same pair, so out 1/2 is one DAW track carrying two different
    // pins. That is exactly what StereoPinSplit exists to avoid, and the contrast the next case asserts.
    CHECK(lanes.pairDiff[0] > kSignal);
}

TEST_CASE("Engine StereoPinSplit gives each pin its own PAIR, mirrored L=R",
          "[audio][channelsplit][nes]") {
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    eng.setAudioRouting(AudioRouting::StereoPinSplit);

    // Same tap as PinSplit — the modes differ only in how many lanes the three streams spread over.
    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);
    CHECK(nes->channelExportMode() == 1);
    CHECK(nes->channelLayout().size() == 3);

    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 8);

    // Pulse now fills BOTH lanes of pair 0 — a centred stereo track, not a hard-left one. The R lane
    // carrying signal at all is the whole feature: under PinSplit it would be TND.
    CHECK(lanes.peak[0] > kSignal);
    CHECK(lanes.peak[1] > kSignal);
    // Bit-identical across each pair (a copy of the L lane, never a second summed write — a doubled
    // stem would show as peak[1] == 2*peak[0] with pairDiff == peak[0]).
    CHECK(lanes.peak[1] == lanes.peak[0]);
    for (int p = 0; p < 3; ++p)
        CHECK(lanes.pairDiff[p] == 0.0f);
    // 3 pins × 2 lanes = 6, so the 4th pair is past the layout and untouched.
    CHECK(lanes.peak[6] == 0.0f);
    CHECK(lanes.peak[7] == 0.0f);
}

TEST_CASE("StereoPinSplit needs 6 lanes, so a narrow host falls back rather than truncating",
          "[audio][channelsplit][nes]") {
    // The SDL 4-channel case: mono Pins (3 lanes) fits, the pair-per-pin layout does not.
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    eng.setAudioRouting(AudioRouting::StereoPinSplit);

    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 4);  // only 4 lanes offered — 6 needed

    // MultiOutRouter → the plain mixed stereo into pair 0, and pair 1 silent.
    CHECK(lanes.peak[0] > kSignal);
    CHECK(lanes.peak[2] == 0.0f);
    CHECK(lanes.peak[3] == 0.0f);
}

TEST_CASE("Engine ChannelSplit on a real NES fans 5 mono core channels across outs 0..4",
          "[audio][channelsplit][nes]") {
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    eng.setAudioRouting(AudioRouting::ChannelSplit);

    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);
    CHECK(nes->channelExportMode() == 3);           // IndividualMono
    CHECK(nes->channelLayout().size() == 8);        // five base voices + three idle S5B voices

    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 8);

    // Square1 is the voice the ch1 note drives. Lanes 5..7 are past the layout and must stay untouched —
    // as stereo pairs these 5 streams would have wanted 10 lanes, so this is the packing working.
    CHECK(lanes.peak[0] > kSignal);
    for (int L = 5; L < 8; ++L)
        CHECK(lanes.peak[L] == 0.0f);
}

TEST_CASE("Engine routes all six VRC7 voices through 16 outputs and restores the mix on a narrow host",
          "[audio][channelsplit][nes][expansion]") {
    std::string path = RP_BLIPTOASTER_ROM_PATH;
    path.replace(path.size() - 4, 4, "-vrc7.nes");
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1, path));
    eng.setAudioRouting(AudioRouting::ChannelSplit);
    REQUIRE(eng.findSystem(1)->channelLayout().size() == 11);

    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 16, 10); // MIDI channel 11 = sixth VRC7 voice, output 11
    CHECK(lanes.peak[10] > kSignal);
    for (std::size_t i = 0; i < lanes.peak.size(); ++i)
        if (i != 10) CHECK(lanes.peak[i] < kSignal);

    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);
    const auto state = nes->saveStateBytes();
    REQUIRE_FALSE(state.empty());
    REQUIRE(nes->loadStateBytes(state));
    eng.setSampleRate(96000.0);
    driveAndMeasure(eng, 1, lanes, 16, 10);
    CHECK(lanes.peak[10] > kSignal);
    CHECK(nes->channelLayout().size() == 11);

    // A host offering fewer than eleven outputs gets the ordinary mix, never truncated stems.
    driveAndMeasure(eng, 1, lanes, 8, 10);
    CHECK(lanes.peak[0] > kSignal);
    CHECK(lanes.peak[1] > kSignal);
    for (int i = 2; i < 8; ++i) CHECK(lanes.peak[i] == 0.0f);

    eng.setAudioRouting(AudioRouting::StereoPinSplit);
    driveAndMeasure(eng, 1, lanes, 16, 10);
    CHECK(lanes.peak[4] > kSignal);
    CHECK(lanes.pairDiff[2] == 0.0f);
    for (std::size_t i = 6; i < lanes.peak.size(); ++i) CHECK(lanes.peak[i] == 0.0f);
}

TEST_CASE("Leaving a split routing restores the NES tap and the plain stereo mix",
          "[audio][channelsplit][nes]") {
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);

    // Round-trip every split mode. Each leaves the core exactly as it was found, so a user flipping
    // through the Audio Routing cycler can't strand the tap armed (which would leave the mix path
    // draining capture streams forever).
    eng.setAudioRouting(AudioRouting::PinSplit);
    CHECK(nes->channelExportMode() == 1);
    eng.setAudioRouting(AudioRouting::ChannelSplit);
    CHECK(nes->channelExportMode() == 3);
    eng.setAudioRouting(AudioRouting::Stereo);
    CHECK(nes->channelExportMode() == 0);
    CHECK(nes->channelLayout().size() == 1);  // back to the single stereo "Mix" stream

    // And the mix still renders: pair 0 carries the note, the other pairs stay silent.
    Lanes lanes;
    driveAndMeasure(eng, 1, lanes, 8);
    CHECK(lanes.peak[0] > kSignal);
    for (int L = 2; L < 8; ++L)
        CHECK(lanes.peak[L] == 0.0f);
}

TEST_CASE("FDS Channels exposes its single wave voice after the five base voices",
          "[audio][channelsplit][nes][expansion]") {
    // Synthetic disk + RAM-resident audio program; this exercises FDS sound without copyrighted BIOS
    // code or a disk game's boot sequence. The mapper can run with its empty BIOS fallback.
    std::vector<std::uint8_t> disk(16 + 65500, 0);
    disk[0] = 'F'; disk[1] = 'D'; disk[2] = 'S'; disk[3] = 0x1a; disk[4] = 1;
    disk[16] = 1;
    const std::string signature = "*NINTENDO-HVC*";
    std::copy(signature.begin(), signature.end(), disk.begin() + 17);
    MesenNesConfig cfg;
    cfg.romPath = "synthetic.fds";
    auto sys = std::make_unique<MesenNesSystem>(1, cfg, disk);
    sys->onActivate(kSampleRate);
    REQUIRE(sys->activated());
    auto* nes = sys.get();
    Engine eng(kSampleRate);
    eng.adoptSystem(std::move(sys));
    eng.setAudioRouting(AudioRouting::ChannelSplit);
    REQUIRE(nes->channelLayout().size() == 6);
    CHECK(nes->channelLayout()[5].name == "FDS Wave");
    CHECK(nes->debugTarget()->getExpansionAudioState().chip == "fds");

    std::vector<std::uint8_t> code{0x78}; // SEI
    const auto write = [&code](std::uint16_t addr, std::uint8_t value) {
        code.insert(code.end(), {0xa9, value, 0x8d, static_cast<std::uint8_t>(addr), static_cast<std::uint8_t>(addr >> 8)});
    };
    write(0x4015, 0); write(0x4023, 2); write(0x4089, 0x80);
    for (std::uint16_t i = 0; i < 64; ++i) write(0x4040 + i, i < 32 ? 0 : 63);
    write(0x4089, 0); write(0x4080, 0xa0); write(0x4082, 0xa0); write(0x4083, 0); write(0x4087, 0x80);
    const auto idle = static_cast<std::uint16_t>(0x200 + code.size());
    code.insert(code.end(), {0x4c, static_cast<std::uint8_t>(idle), static_cast<std::uint8_t>(idle >> 8)});
    for (std::size_t i = 0; i < code.size(); ++i)
        REQUIRE(nes->writeCpuByte(static_cast<std::uint32_t>(0x200 + i), code[i]));
    REQUIRE(nes->setCpuRegister("pc", 0x200));

    Lanes lanes;
    for (int b = 0; b < kBootBlocks; ++b) eng.processBlock(kFrames, lanes.ptr.data(), 16);
    for (int b = 0; b < kPlayBlocks; ++b) {
        eng.processBlock(kFrames, lanes.ptr.data(), 16);
        lanes.accumulatePeaks();
    }
    CHECK(lanes.peak[5] > kSignal);
    for (std::size_t i = 0; i < lanes.peak.size(); ++i)
        if (i != 5) CHECK(lanes.peak[i] < kSignal);
}

TEST_CASE("A second system disarms the NES tap and falls back to the per-instance router",
          "[audio][channelsplit][nes]") {
    Engine eng(kSampleRate);
    eng.adoptSystem(buildNes(1));
    eng.setAudioRouting(AudioRouting::PinSplit);

    auto* nes = dynamic_cast<MesenNesSystem*>(eng.findSystem(1));
    REQUIRE(nes != nullptr);
    REQUIRE(nes->channelExportMode() == 1);

    // The splits are single-system-only, so adopting a peer must retire the plan AND the tap it needed —
    // otherwise the mix path would keep draining capture streams nothing reads.
    eng.adoptSystem(buildNes(2));
    CHECK(nes->channelExportMode() == 0);
    CHECK(nes->channelLayout().size() == 1);

    // Removing the peer re-enters the split, re-arming from scratch: the plan tracks the system set, not
    // just the last setAudioRouting call.
    eng.removeSystem(2);
    CHECK(nes->channelExportMode() == 1);
    CHECK(nes->channelLayout().size() == 3);
}
