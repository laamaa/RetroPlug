#include <catch2/catch_test_macros.hpp>
#include "host/dsp/SeekWorker.hpp"

#include <chrono>
#include <stdexcept>
#include <string>

namespace {
using namespace std::chrono_literals;

std::vector<std::uint8_t> compile(const std::string& source) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    JSValue code = JS_Eval(ctx, source.data(), source.size(), "seek-worker-test",
                           JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(code)) {
        JS_FreeValue(ctx, code);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        throw std::runtime_error("invalid worker test source");
    }
    std::size_t size = 0;
    auto* bytes = JS_WriteObject(ctx, &size, code, JS_WRITE_OBJ_BYTECODE);
    std::vector<std::uint8_t> result(bytes, bytes + size);
    js_free(ctx, bytes);
    JS_FreeValue(ctx, code);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return result;
}

using Song = std::array<std::uint8_t, 32768>;

void leaveReady(SeekWorker& worker, std::uint32_t token, const Song& song) {
    // Submission is best-effort; retry while leaving the result undelivered.
    const auto deadline = std::chrono::steady_clock::now() + 100ms;
    while (std::chrono::steady_clock::now() < deadline) {
        worker.submit(1, token, 0, song.data(), song.size());
        std::this_thread::sleep_for(1ms);
    }
}

SeekWorker::Result waitResult(SeekWorker& worker, std::uint32_t token,
                              const Song* song = nullptr, double clock = 0) {
    SeekWorker::Result result;
    bool found = false;
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!found && std::chrono::steady_clock::now() < deadline) {
        if (song) worker.submit(1, token, clock, song->data(), song->size());
        worker.drain([&](const SeekWorker::Result& value) {
            if (value.token != token) throw std::runtime_error("obsolete worker result");
            result = value;
            found = true;
        });
        if (!found) std::this_thread::sleep_for(1ms);
    }
    if (!found) throw std::runtime_error("seek worker result timed out");
    return result;
}

// Exercise requests arriving while a cold model calculation is running.
std::vector<std::uint8_t> slowKernel() {
    return compile(R"(
      let calls = 0;
      globalThis.prepareRisaSeek = () => {
        const packet = new Array(48).fill(0);
        packet[2] = ++calls;
        const end = Date.now() + 50;
        while (Date.now() < end) {}
        return packet;
      };
    )");
}
}

TEST_CASE("seek worker coalesces duplicate requests and retries after delivery", "[seek-worker]") {
    SeekWorker worker;
    worker.setKernel(slowKernel());
    std::array<std::uint8_t, 32768> song{};
    for (int i = 0; i < 100; ++i) worker.submit(1, 1, 192, song.data(), song.size());
    REQUIRE(waitResult(worker, 1, &song, 192).packet[2] == 1);
    worker.submit(1, 2, 96, song.data(), song.size());
    REQUIRE(waitResult(worker, 2, &song, 96).packet[2] == 2);
}

TEST_CASE("seek worker kernel changes discard old calculations", "[seek-worker]") {
    SeekWorker worker;
    worker.setKernel(slowKernel());
    std::array<std::uint8_t, 32768> song{};
    worker.submit(1, 1, 192, song.data(), song.size());
    // Allow the old request to enter its model build before replacement.
    std::this_thread::sleep_for(10ms);
    worker.setKernel(compile(R"(
      globalThis.prepareRisaSeek = () => new Array(48).fill(42);
    )"));
    worker.submit(1, 2, 96, song.data(), song.size());
    const auto result = waitResult(worker, 2, &song, 96);
    REQUIRE(result.ok);
    REQUIRE(result.packet[0] == 42);
    bool obsolete = false;
    worker.drain([&](const SeekWorker::Result& value) { obsolete |= value.token == 1; });
    REQUIRE_FALSE(obsolete);
}

TEST_CASE("seek worker drain releases the lock before calling its consumer", "[seek-worker]") {
    SeekWorker worker;
    worker.setKernel(compile(R"(
      globalThis.prepareRisaSeek = () => new Array(48).fill(0);
    )"));
    std::array<std::uint8_t, 32768> song{};
    worker.submit(1, 1, 0, song.data(), song.size());
    bool delivered = false;
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!delivered && std::chrono::steady_clock::now() < deadline) {
        worker.submit(1, 1, 0, song.data(), song.size());
        worker.drain([&](const SeekWorker::Result&) {
            delivered = true;
            // The mailbox uses try-lock, so allow transient worker contention.
            // A callback running under the mailbox lock would drop ALL tries.
            for (int i = 0; i < 100; ++i) {
                worker.submit(1, 2, 1, song.data(), song.size());
                std::this_thread::sleep_for(1ms);
            }
        });
        if (!delivered) std::this_thread::sleep_for(1ms);
    }
    REQUIRE(delivered);
    REQUIRE(waitResult(worker, 2).ok);
}

TEST_CASE("seek worker drops ready packets after live song edits", "[seek-worker]") {
    SeekWorker worker;
    worker.setKernel(compile(R"(
      globalThis.prepareRisaSeek = (_system, buffer) =>
        new Array(48).fill(new Uint8Array(buffer)[0]);
    )"));
    Song song{};
    REQUIRE(waitResult(worker, 9, &song).ok); // worker runtime is loaded
    leaveReady(worker, 1, song);
    song[0] = 17;
    REQUIRE(waitResult(worker, 1, &song).packet[0] == 17);
}

TEST_CASE("seek worker preserves a ready clock for unchanged song data", "[seek-worker]") {
    SeekWorker worker;
    worker.setKernel(compile(R"(
      globalThis.prepareRisaSeek = (_system, _buffer, clock) => new Array(48).fill(clock);
    )"));
    Song song{};
    REQUIRE(waitResult(worker, 9, &song).ok);
    leaveReady(worker, 1, song);
    worker.submit(1, 1, 1, song.data(), song.size());
    const auto result = waitResult(worker, 1);
    REQUIRE(result.clock == 0); // the fallback catches this small gap up itself
}
