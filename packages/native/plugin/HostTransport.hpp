#pragma once
#include <cmath>

namespace retroplug {
// Called after control commands are drained and BEFORE rendering the block.
// Absolute PPQ is authoritative; Engine's own increment is only a prediction
// for a later block whose host lacks musical time.
template <typename Engine, typename TimePosition>
void applyHostTransport(Engine& engine, const TimePosition& tp) {
    if (tp.quarterNotesValid && std::isfinite(tp.quarterNotes))
        engine.setPpq(tp.quarterNotes);
    const double bpm = (tp.bbt.valid || tp.quarterNotesValid) &&
        std::isfinite(tp.bbt.beatsPerMinute) && tp.bbt.beatsPerMinute > 0.0
        ? tp.bbt.beatsPerMinute : 120.0;
    engine.setBpm(bpm);
    const bool preroll = tp.quarterNotesValid && std::isfinite(tp.quarterNotes) && tp.quarterNotes < 0.0;
    engine.setTransport(tp.playing && !preroll);
}
}
