#!/usr/bin/env python3
"""The input helper's side of game mode, for the unit tests.

It runs daemon/input.py's own code for the phones' controllers: the
connection to the daemon, the controllers it asks for, and the guide
button's word to the screen daemon. Only the uinput devices are stand-ins,
since those need the box. What each one would be, and each report written
to it, is printed as a line of JSON for the test to read.

  phonepad-helper.py <daemon folder> <the daemon's port>
"""

import json
import struct
import sys
import threading

sys.path.insert(0, sys.argv[1])
import input as origaitv_input  # noqa: E402  pylint: disable=wrong-import-position


def say(**line):
    print(json.dumps(line), flush=True)


def make(slot):
    """A stand-in for make_pad: the same writer and the same way out."""
    say(made=slot, name=origaitv_input.PAD_NAME.decode(), id=list(origaitv_input.PAD_ID), keys=list(origaitv_input.PAD_KEYS), axes=[list(axis) for axis in origaitv_input.PAD_AXES])

    def write(data):
        events = []
        for i in range(0, len(data), origaitv_input.EVENT_SIZE):
            _, _, kind, code, value = struct.unpack_from("llHHi", data, i)
            if kind != origaitv_input.EV_SYN:
                events.append([kind, code, value])
        say(slot=slot, events=events)

    return write, lambda: say(gone=slot)


origaitv_input.serve_pads(threading.Event(), make=make, address=("127.0.0.1", int(sys.argv[2])), retry=0.1, refused=0.2)
