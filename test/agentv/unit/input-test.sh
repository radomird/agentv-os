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
PY
}

run || fail "the virtual input device's tests pass"
