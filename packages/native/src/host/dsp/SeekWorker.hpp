#pragma once

// Bounded mailbox between the block owner and a private QuickJS worker.
// The kernel bundle owns song interpretation; all JS reloads run off-thread.
#include <array>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

extern "C" {
#include "quickjs.h"
}

class SeekWorker {
public:
    struct Result {
        std::uint32_t system = 0, token = 0;
        double clock = 0;
        std::array<std::uint8_t, 48> packet{};
        bool ok = false;
    };

    // Allocate the mailbox and start the thread with its owning DspRuntime,
    // before the audio thread takes ownership. Kernel changes never join it.
    SeekWorker() : thread_([this] { run(); }) {}
    ~SeekWorker() {
        { std::lock_guard lock(mutex_); stop_ = true; }
        wake_.notify_one();
        thread_.join();
    }

    void setKernel(const std::vector<std::uint8_t>& bytecode) {
        auto code = bytecode;
        {
            std::lock_guard lock(mutex_);
            pendingCode_.swap(code);
            kernelPending_ = true;
            ++kernelRevision_;
            for (auto& slot : slots_) {
                ++slot.epoch;
                slot.id = 0;
                slot.pending = slot.processing = slot.ready = false;
            }
        }
        wake_.notify_one();
    }

    // Audio thread: try once, retry next block if the worker owns the mailbox.
    // Matching requests coalesce while pending, processing or awaiting delivery.
    void submit(std::uint32_t id, std::uint32_t token, double clock,
                const std::uint8_t* song, std::size_t size) {
        if (!song || size < 32768) return;
        std::unique_lock lock(mutex_, std::try_to_lock);
        if (!lock) return;
        Slot* slot = nullptr;
        for (auto& s : slots_) if (s.id == id) { slot = &s; break; }
        if (!slot) for (auto& s : slots_) if (!s.id) { slot = &s; slot->id = id; break; }
        if (!slot) return;
        const bool same = slot->token == token && sameSong(slot->song.data(), song);
        if (same && slot->clock == clock &&
            (slot->pending || slot->processing ||
             (slot->ready && slot->result.token == token && slot->result.clock == clock))) return;
        // An older clock for unchanged song/token is useful to the catch-up
        // path; a packet for changed song bytes or token must not escape.
        if (!same) slot->ready = false;
        slot->token = token;
        slot->clock = clock;
        std::memcpy(slot->song.data(), song, slot->song.size());
        slot->pending = true;
        wake_.notify_one();
    }

    template <typename Fn> void drain(Fn&& fn) {
        std::array<Result, 64> ready;
        std::size_t count = 0;
        {
            std::unique_lock lock(mutex_, std::try_to_lock);
            if (!lock) return;
            for (auto& slot : slots_) if (slot.ready) {
                ready[count++] = slot.result;
                slot.ready = false;
            }
        }
        // The callback may allocate/GC in the audio runtime. Never hold the
        // mailbox lock across that work.
        for (std::size_t i = 0; i < count; ++i) fn(ready[i]);
    }

    // Called by the block owner on core reset/replacement. The epoch rejects
    // any old calculation still in flight, including one with the same token.
    void invalidate(std::uint32_t id) {
        std::lock_guard lock(mutex_);
        bool present = false;
        for (const auto& slot : slots_) if (slot.id == id) present = true;
        if (!present) for (auto& slot : slots_) if (!slot.id) { slot.id = id; break; }
        for (auto& slot : slots_) if (slot.id == id) {
            slot.pending = slot.processing = false;
            ++slot.epoch;
            slot.result = {};
            slot.result.system = id; // token zero tells the kernel to re-arm
            slot.ready = true;
        }
    }

    void forget(std::uint32_t id) {
        std::lock_guard lock(mutex_);
        for (auto& slot : slots_) if (slot.id == id) {
            ++slot.epoch;
            slot.id = 0;
            slot.pending = slot.processing = slot.ready = false;
        }
    }

private:
    struct Slot {
        std::uint32_t id = 0, token = 0, epoch = 0;
        double clock = 0;
        std::array<std::uint8_t, 32768> song{};
        bool pending = false, processing = false, ready = false;
        Result result;
    };
    static bool sameSong(const std::uint8_t* a, const std::uint8_t* b) {
        return std::memcmp(a, b, 8192) == 0 &&
            std::memcmp(a + 0x6000, b + 0x6000, 8128) == 0 &&
            std::memcmp(a + 0x2000, b + 0x2000, 0x1690) == 0 &&
            std::memcmp(a + 0x3e80, b + 0x3e80, 8) == 0;
    }
    void run() {
        JSRuntime* rt = nullptr;
        JSContext* ctx = nullptr;
        JSValue prepare = JS_UNDEFINED;
        std::uint64_t loadedRevision = 0;
        auto clearKernel = [&] {
            if (ctx) {
                JS_FreeValue(ctx, prepare);
                JS_FreeContext(ctx);
            }
            if (rt) JS_FreeRuntime(rt);
            rt = nullptr;
            ctx = nullptr;
            prepare = JS_UNDEFINED;
        };
        Slot request;
        for (;;) {
            std::size_t index = slots_.size();
            std::vector<std::uint8_t> code;
            std::uint64_t revision;
            bool reload;
            {
                std::unique_lock lock(mutex_);
                wake_.wait(lock, [&] {
                    if (stop_ || kernelPending_) return true;
                    for (const auto& s : slots_) if (s.pending) return true;
                    return false;
                });
                if (stop_) break;
                revision = kernelRevision_;
                reload = kernelPending_;
                if (reload) {
                    code.swap(pendingCode_);
                    kernelPending_ = false;
                } else {
                    // Round-robin avoids starving a second cart.
                    for (std::size_t n = 0; n < slots_.size(); ++n) {
                        const auto i = (next_ + n) % slots_.size();
                        if (slots_[i].pending) { index = i; break; }
                    }
                    request = slots_[index];
                    slots_[index].pending = false;
                    slots_[index].processing = true;
                    next_ = (index + 1) % slots_.size();
                }
            }
            if (reload) {
                clearKernel();
                rt = JS_NewRuntime();
                if (rt) ctx = JS_NewContext(rt);
                if (ctx) {
                    JSValue obj = JS_ReadObject(ctx, code.data(), code.size(), JS_READ_OBJ_BYTECODE);
                    if (!JS_IsException(obj)) obj = JS_EvalFunction(ctx, obj);
                    if (!JS_IsException(obj)) {
                        JSValue global = JS_GetGlobalObject(ctx);
                        prepare = JS_GetPropertyStr(ctx, global, "prepareRisaSeek");
                        JS_FreeValue(ctx, global);
                    }
                    JS_FreeValue(ctx, obj);
                }
                loadedRevision = revision;
                continue;
            }
            Result result;
            result.system = request.id;
            result.token = request.token;
            result.clock = request.clock;
            if (ctx && loadedRevision == revision && JS_IsFunction(ctx, prepare)) {
                JSValue args[] = {
                    JS_NewInt64(ctx, request.id),
                    JS_NewArrayBufferCopy(ctx, request.song.data(), request.song.size()),
                    JS_NewFloat64(ctx, request.clock),
                    JS_NewInt64(ctx, request.epoch),
                };
                JSValue value = JS_Call(ctx, prepare, JS_UNDEFINED, 4, args);
                if (!JS_IsException(value) && JS_IsArray(value)) {
                    JSValue length = JS_GetPropertyStr(ctx, value, "length");
                    std::uint32_t count = 0;
                    JS_ToUint32(ctx, &count, length);
                    JS_FreeValue(ctx, length);
                    result.ok = count == result.packet.size();
                    if (result.ok) for (std::uint32_t i = 0; i < count; ++i) {
                        JSValue byte = JS_GetPropertyUint32(ctx, value, i);
                        std::uint32_t number = 0;
                        JS_ToUint32(ctx, &number, byte);
                        result.packet[i] = static_cast<std::uint8_t>(number);
                        JS_FreeValue(ctx, byte);
                    }
                }
                if (JS_IsException(value)) {
                    JSValue error = JS_GetException(ctx);
                    JS_FreeValue(ctx, error);
                }
                JS_FreeValue(ctx, value);
                for (auto arg : args) JS_FreeValue(ctx, arg);
            }
            {
                std::lock_guard lock(mutex_);
                auto& slot = slots_[index];
                if (kernelRevision_ == revision && slot.id == request.id && slot.epoch == request.epoch) {
                    slot.processing = false;
                    if (slot.token == request.token && sameSong(slot.song.data(), request.song.data())) {
                        slot.result = result;
                        slot.ready = true;
                        if (slot.clock == request.clock) slot.pending = false;
                    }
                }
            }
        }
        clearKernel();
    }

    std::mutex mutex_;
    std::condition_variable wake_;
    std::array<Slot, 64> slots_{};
    std::vector<std::uint8_t> pendingCode_;
    std::uint64_t kernelRevision_ = 0;
    bool stop_ = false, kernelPending_ = false;
    std::size_t next_ = 0;
    std::thread thread_;
};
