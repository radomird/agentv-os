#!/bin/bash

# Guards daemon/input.py, AgenTV's virtual input device (ADR-008): what it
# writes for a key, typed text, the pointer and a bad request. The uinput
# device itself needs the box (an image check and agentv selftest see it);
# here the events go to a stand-in.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

run() {
  python3 -I - "$ROOT/daemon" <<'PY'
import struct, sys
sys.path.insert(0, sys.argv[1])
import input as agentv_input

written = []
device = agentv_input.Device(written.append)

def events():
    out = []
    for chunk in written:
        for i in range(0, len(chunk), 24):
            _, _, kind, code, value = struct.unpack("llHHi", chunk[i:i + 24])
            if kind != 0:
                out.append((kind, code, value))
    written.clear()
    return out

device.handle({"key": "up"})
assert events() == [(1, 103, 1), (1, 103, 0)], "up"
print("ok - a key is a press and a release")

device.handle({"key": "back"})
assert events() == [(1, 1, 1), (1, 1, 0)], "back is Esc, AgenTV's back key"
device.handle({"key": "home"})
assert events() == [(1, 172, 1), (1, 172, 0)], "home is a remote's Home button"
print("ok - back is Esc (ADR-008), and home is a remote's Home button")

device.handle({"text": "Hi!"})
assert events() == [
    (1, 42, 1), (1, 35, 1), (1, 35, 0), (1, 42, 0),
    (1, 23, 1), (1, 23, 0),
    (1, 42, 1), (1, 2, 1), (1, 2, 0), (1, 42, 0),
], "Hi!"
print("ok - text is typed on a US layout, with Shift where it needs it")

device.handle({"move": [5, -3]})
assert events() == [(2, 0, 5), (2, 1, -3)], "move"
device.handle({"click": "left"})
assert events() == [(1, 0x110, 1), (1, 0x110, 0)], "click"
device.handle({"scroll": -1})
assert events() == [(2, 8, -1)], "scroll"
print("ok - the pointer moves, clicks and scrolls")

for bad in ({"key": "nope"}, {"text": "é"}, {"click": "fourth"}, {"jump": 1}):
    try:
        device.handle(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad}")
assert events() == [], "nothing half-typed"
print("ok - a request it can't do is refused, with nothing half-typed")

assert struct.calcsize("HHHH80sI") == 92 and agentv_input.UI_DEV_SETUP == 0x405C5503
print("ok - the device setup matches struct uinput_setup")

import time
started = time.monotonic()
device.handle({"hold": "back", "ms": 150})
assert time.monotonic() - started >= 0.15, "held for the time asked"
assert events() == [(1, 1, 1), (1, 1, 0)], "hold is one press and one release"
for bad in ({"hold": "back", "ms": 9000}, {"hold": "nope", "ms": 10}):
    try:
        device.handle(bad)
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad}")
print("ok - hold keeps a key down for a while, such as Back for Home (ADR-031)")

# A gamepad, as a FIFO: its guide button goes down and up, and A is pressed.
import os, tempfile, threading
fifo = os.path.join(tempfile.mkdtemp(), "pad-event-joystick")
os.mkfifo(fifo)
writer = os.open(fifo, os.O_RDWR)
guides = []
stop = threading.Event()
watcher = threading.Thread(target=agentv_input.watch_guide, args=(lambda: [fifo], lambda: guides.append(1), stop, 0.05))
watcher.start()
time.sleep(0.2)
for code, value in ((0x13C, 1), (0x13C, 0), (0x130, 1), (0x130, 0), (0x13C, 1)):
    os.write(writer, agentv_input.event(1, code, value) + agentv_input.event(0, 0, 0))
deadline = time.monotonic() + 2
while len(guides) < 2 and time.monotonic() < deadline:
    time.sleep(0.05)
stop.set()
watcher.join(2)
os.close(writer)
assert guides == [1, 1], f"the guide button went down twice, not {guides}"
assert not watcher.is_alive(), "the watcher stops"
print("ok - a gamepad's guide button is Home, and its other buttons aren't")
PY
}

run || fail "the virtual input device's tests pass"
