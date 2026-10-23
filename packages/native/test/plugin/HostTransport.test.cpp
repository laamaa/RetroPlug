#include <catch2/catch_test_macros.hpp>
#include <limits>
#include "HostTransport.hpp"

namespace {
struct Clock {
    double ppq = 0, bpm = 120;
    bool playing = false;
    void setPpq(double p) { ppq = p < 0 ? 0 : p; }
    void setBpm(double b) { bpm = b; }
    void setTransport(bool p) { playing = p; }
    void renderQuarter() { if (playing) ppq += 1; }
};
struct Position {
    double quarterNotes = 0;
    bool quarterNotesValid = true, playing = true;
    struct { bool valid = true; double beatsPerMinute = 120; } bbt;
};
}

TEST_CASE("DAW nonzero start and rewind override accumulated playback", "[transport]") {
    Clock engine;
    Position tp;
    tp.quarterNotes = 64;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.ppq == 64);
    engine.renderQuarter();
    tp.quarterNotes = 0;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.ppq == 0);
}
TEST_CASE("successive host block starts are assigned once", "[transport]") {
    Clock engine;
    Position tp;
    for (int i = 0; i < 4; ++i) {
        tp.quarterNotes = 32 + i;
        retroplug::applyHostTransport(engine, tp);
        REQUIRE(engine.ppq == 32 + i);
        engine.renderQuarter();
    }
}
TEST_CASE("absolute musical time needs neither a meter nor sample-time conversion", "[transport]") {
    Clock engine;
    Position tp;
    tp.bbt.valid = false;
    tp.bbt.beatsPerMinute = 87;
    tp.quarterNotes = 17.5;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.ppq == 17.5);
    REQUIRE(engine.bpm == 87);
}
TEST_CASE("invalid musical positions retain the Engine prediction", "[transport]") {
    Clock engine;
    engine.ppq = 42;
    Position tp;
    tp.quarterNotes = std::numeric_limits<double>::quiet_NaN();
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.ppq == 42);
    tp.quarterNotes = 0;
    tp.quarterNotesValid = false;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.ppq == 42);
}
TEST_CASE("negative host preroll gates sequencer transport until song zero", "[transport]") {
    Clock engine;
    Position tp;
    tp.quarterNotes = -2;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE_FALSE(engine.playing);
    tp.quarterNotes = 0;
    retroplug::applyHostTransport(engine, tp);
    REQUIRE(engine.playing);
    REQUIRE(engine.ppq == 0);
}
