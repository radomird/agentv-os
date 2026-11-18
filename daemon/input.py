#!/usr/bin/env python3
"""OrigaiTV's virtual input device (ADR-008).

The phone's d-pad and keyboard, and later the gamepad mapping, reach the TV
through one virtual keyboard and pointer, "OrigaiTV remote", so they work in
every window: the home screen, a service's page, Steam. It's a uinput device
made by the person logged in on the screen, which the udev rule in
system/70-origaitv-uinput.rules allows, the way Steam's own rule does for Steam
Input. Nobody else on the box can use it.

  input.py serve              make the device and take requests on
                              $XDG_RUNTIME_DIR/origaitv/input.sock
  input.py key <name>...      press and release keys: up, down, left, right,
                              enter, back, home, playpause, a, 1, ...
  input.py hold <name> <s>    press a key, hold it for s seconds, release it
  input.py text <text>        type text (US layout)
  input.py text -             type text read from stdin, so it isn't on
                              the command line for ps to show
  input.py move <dx> <dy>     move the pointer; pushed far enough, it stops
                              in a corner, such as the one with Home
  input.py click [button]     click: left, the default, right or middle
  input.py wheel <h> <v>      turn the wheel: sideways h and up v, where
                              120 is one notch of a mouse's wheel

What it types is never logged, and no error names it (ADR-032): it can be
a password, typed from the phone.

A request is one JSON line: {"key": "up"}, {"hold": "back", "ms": 1200},
{"text": "hello"}, {"move": [dx, dy]}, {"click": "left"}, {"scroll": n}
in whole notches, up for more than 0, or {"wheel": [h, v]}, right and up
in 120ths of a notch. The answer is "ok" or an error, on one line.

The wheel is a high-resolution one, both ways, as a touchpad's or a modern
mouse's is, so the phone's two fingers scroll smoothly (ADR-103). It sends
the whole notches too, once a notch's worth has gone, as such a mouse does,
for whatever reads only those.

It also watches the gamepads for their guide button, which is Home
(ADR-031), and tells the screen daemon: once when it goes down, and once
more when it has stayed down for a second, which is Home from a game too
(ADR-084). It only reads the gamepads and never grabs them, so the window
in front gets every button as it is, the guide button too.

A phone in game mode is a controller too (ADR-113), and this makes it:
a second kind of device, "OrigaiTV phone controller", one for each phone
and four at most. The daemon has the phones, and can't make a device, so
this holds a connection open to the daemon and makes what it asks for,
a line of JSON at a time:
  {"open": 1}                      make controller 1, answered {"opened": 1}
                                   or {"failed": 1, "why": "..."}
  {"state": [1, buttons, x, y], "n": 7}
                                   what controller 1 holds now, answered
                                   {"took": [1, 7]} once it's written
  {"close": 1}                     take controller 1 away
A controller lasts as long as that connection does. When it ends, or the
daemon says nothing on it for a few seconds, every one of them goes.

Standard library only.
"""

import fcntl
import glob
import json
import os
import re
import select
import socket
import struct
import sys
import threading
import time

# linux/input-event-codes.h
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT, SYN_DROPPED = 0, 3
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 0x0B, 0x0C
# One notch of the wheel, in the high-resolution wheel's units.
NOTCH = 120
# The most one request turns the wheel, in notches.
WHEEL_MOST = 50
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BTN_MODE = 0x13C
BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR, BTN_SELECT, BTN_START = 0x136, 0x137, 0x13A, 0x13B
BTN_THUMBL, BTN_THUMBR = 0x13D, 0x13E
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05
ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11
EVENT_SIZE = struct.calcsize("llHHi")
KEY_LEFTSHIFT = 42
BUS_VIRTUAL = 0x06
BUS_USB = 0x03

# linux/uinput.h
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_ABS_SETUP = 0x401C5504
UI_DEV_SETUP = 0x405C5503
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

NAME = b"OrigaiTV remote"

# Typed text goes a character at a time, with a pause after each, so the
# compositor reads the events as they come. The kernel keeps 128 events for
# each reader of the device, about 30 characters; all at once, a long text on
# a busy box can fill that, the kernel drops what it holds, and the text
# arrives with characters missing. 12 ms is xdotool's own delay.
TYPE_GAP = 0.012

# How long the guide button stays down before it's Home from a game too:
# the same second as Back's hold (the screen daemon's backHoldMs).
GUIDE_HOLD = 1.0

KEYS = {
    "esc": 1, "back": 1, "backspace": 14, "tab": 15, "enter": 28, "space": 57,
    "up": 103, "left": 105, "right": 106, "down": 108,
    "pageup": 104, "pagedown": 109, "end": 107, "delete": 111,
    # KEY_HOMEPAGE, what a remote's Home button sends. A keyboard's Home key
    # (KEY_HOME, 102) is "home-key".
    "home": 172, "home-key": 102,
    "mute": 113, "volumedown": 114, "volumeup": 115,
    "playpause": 164, "stop": 166, "previous": 165, "next": 163,
    "f11": 87,
}
for i, letter in enumerate("qwertyuiop"):
    KEYS[letter] = 16 + i
for i, letter in enumerate("asdfghjkl"):
    KEYS[letter] = 30 + i
for i, letter in enumerate("zxcvbnm"):
    KEYS[letter] = 44 + i
for i, digit in enumerate("1234567890"):
    KEYS[digit] = 2 + i

# Characters to (key, shift), on a US layout.
CHARS = {c: (c, False) for c in "abcdefghijklmnopqrstuvwxyz0123456789"}
CHARS.update({c.upper(): (c, True) for c in "abcdefghijklmnopqrstuvwxyz"})
CHARS.update({" ": ("space", False), "\n": ("enter", False), "\t": ("tab", False)})
PUNCTUATION = {
    "-": (12, False), "_": (12, True), "=": (13, False), "+": (13, True),
    "[": (26, False), "{": (26, True), "]": (27, False), "}": (27, True),
    ";": (39, False), ":": (39, True), "'": (40, False), '"': (40, True),
    "`": (41, False), "~": (41, True), "\\": (43, False), "|": (43, True),
    ",": (51, False), "<": (51, True), ".": (52, False), ">": (52, True),
    "/": (53, False), "?": (53, True),
    "!": (2, True), "@": (3, True), "#": (4, True), "$": (5, True), "%": (6, True),
    "^": (7, True), "&": (8, True), "*": (9, True), "(": (10, True), ")": (11, True),
}
BUTTONS = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}


def event(kind, code, value):
    """One struct input_event, as uinput reads it on 64-bit Linux."""
    now = time.time()
    return struct.pack("llHHi", int(now), int((now % 1) * 1_000_000), kind, code, value)


def unknown_key(name):
    """A key's name in the error, unless it's one character, which can be
    part of something typed."""
    return ValueError(f"unknown key: {name}" if len(str(name)) > 1 else "unknown key")


def code_of_char(char):
    if char in CHARS:
        key, shift = CHARS[char]
        return KEYS[key], shift
    if char in PUNCTUATION:
        return PUNCTUATION[char]
    # Not the character itself: it can be part of a password.
    raise ValueError("can't type one of those characters yet (US layout)")


class Device:
    """Writes key and pointer events. The writer is the uinput file, or a
    stand-in in the unit tests."""

    def __init__(self, write, pause=time.sleep):
        self.write = write
        self.pause = pause
        # What's turned of a notch so far, sideways and up, until a whole one
        # has gone.
        self.part = [0, 0]

    def emit(self, *events):
        self.write(b"".join(events) + event(EV_SYN, SYN_REPORT, 0))

    def tap(self, code, shift=False):
        if shift:
            self.emit(event(EV_KEY, KEY_LEFTSHIFT, 1))
        self.emit(event(EV_KEY, code, 1))
        self.emit(event(EV_KEY, code, 0))
        if shift:
            self.emit(event(EV_KEY, KEY_LEFTSHIFT, 0))

    def key(self, name):
        if name not in KEYS:
            raise unknown_key(name)
        self.tap(KEYS[name])

    def hold(self, name, ms):
        if name not in KEYS:
            raise unknown_key(name)
        if not 0 <= ms <= 5000:
            raise ValueError("hold for up to 5000 ms")
        self.emit(event(EV_KEY, KEYS[name], 1))
        time.sleep(ms / 1000)
        self.emit(event(EV_KEY, KEYS[name], 0))

    def text(self, text):
        codes = [code_of_char(c) for c in text]
        for code, shift in codes:
            self.tap(code, shift)
            self.pause(TYPE_GAP)

    def move(self, dx, dy):
        self.emit(event(EV_REL, REL_X, int(dx)), event(EV_REL, REL_Y, int(dy)))

    def click(self, button):
        if button not in BUTTONS:
            raise ValueError(f"unknown button: {button}")
        self.emit(event(EV_KEY, BUTTONS[button], 1))
        self.emit(event(EV_KEY, BUTTONS[button], 0))

    def scroll(self, amount):
        """Whole notches up, or down for less than 0, as the old remote's
        scroll buttons send."""
        if not isinstance(amount, int) or isinstance(amount, bool) or not 0 < abs(amount) <= WHEEL_MOST:
            raise ValueError(f"scroll by 1 to {WHEEL_MOST} notches")
        self.emit(event(EV_REL, REL_WHEEL_HI_RES, amount * NOTCH), event(EV_REL, REL_WHEEL, amount))

    def wheel(self, across, up):
        """The wheel turned sideways and up, in 120ths of a notch, with a
        whole notch each way as each one's worth goes by."""
        turn = []
        for value in (across, up):
            if not isinstance(value, int) or isinstance(value, bool) or abs(value) > WHEEL_MOST * NOTCH:
                raise ValueError(f"turn the wheel by up to {WHEEL_MOST * NOTCH} each way")
            turn.append(value)
        if turn == [0, 0]:
            raise ValueError("turn the wheel one way or the other")
        events = []
        for axis, (value, fine, whole) in enumerate(((turn[0], REL_HWHEEL_HI_RES, REL_HWHEEL), (turn[1], REL_WHEEL_HI_RES, REL_WHEEL))):
            if not value:
                continue
            # A change of way starts the notch again.
            if self.part[axis] * value < 0:
                self.part[axis] = 0
            self.part[axis] += value
            notches = int(self.part[axis] / NOTCH)
            self.part[axis] -= notches * NOTCH
            events.append(event(EV_REL, fine, value))
            if notches:
                events.append(event(EV_REL, whole, notches))
        self.emit(*events)

    def handle(self, request):
        if "key" in request:
            self.key(str(request["key"]))
        elif "hold" in request:
            self.hold(str(request["hold"]), int(request.get("ms", 1000)))
        elif "text" in request:
            self.text(str(request["text"]))
        elif "move" in request:
            self.move(*request["move"])
        elif "click" in request:
            self.click(str(request["click"]))
        elif "scroll" in request:
            self.scroll(request["scroll"])
        elif "wheel" in request:
            turn = request["wheel"]
            if not isinstance(turn, list) or len(turn) != 2:
                raise ValueError("wheel is [sideways, up]")
            self.wheel(*turn)
        else:
            raise ValueError("a request is key, hold, text, move, click, scroll or wheel")


def create():
    """Makes the uinput device and returns its file descriptor."""
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    for kind in (EV_KEY, EV_REL):
        fcntl.ioctl(fd, UI_SET_EVBIT, kind)
    for code in sorted(set(KEYS.values()) | {KEY_LEFTSHIFT} | {c for c, _ in PUNCTUATION.values()} | set(BUTTONS.values())):
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    for code in (REL_X, REL_Y, REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES):
        fcntl.ioctl(fd, UI_SET_RELBIT, code)
    # struct uinput_setup: struct input_id, name[80], ff_effects_max.
    fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("HHHH80sI", BUS_VIRTUAL, 0, 1, 1, NAME, 0))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


# --- The controller a phone in game mode is (ADR-113) -----------------------

PAD_NAME = b"OrigaiTV phone controller"
# What it says it is: the wired controller nearly every game already has a
# layout for. A game, Steam and a browser each pick a controller's layout by
# these numbers, and one they don't know needs setting up by hand before a
# single button works. The name is its own.
PAD_ID = (BUS_USB, 0x045E, 0x028E, 0x0114)
PAD_MOST = 4
# How far the stick goes each way, and how far along it counts as a
# direction on the d-pad: half way.
STICK = 32767
DPAD_FROM = 16384
# A shoulder button at the back is an axis on that controller, a trigger.
# The phone's is a button, so it's all the way in or out.
TRIGGER = 255
# A state's bits, in order: A, B, X and Y, the two shoulders in front, the
# two behind them, View, Menu and the guide button. On that controller X
# and Y are the codes the kernel calls north and west.
PAD_BITS = (
    (EV_KEY, BTN_SOUTH), (EV_KEY, BTN_EAST), (EV_KEY, BTN_NORTH), (EV_KEY, BTN_WEST),
    (EV_KEY, BTN_TL), (EV_KEY, BTN_TR), (EV_ABS, ABS_Z), (EV_ABS, ABS_RZ),
    (EV_KEY, BTN_SELECT), (EV_KEY, BTN_START), (EV_KEY, BTN_MODE),
)
GUIDE_BIT = 10
# Everything the controller it stands in for has, in its order, so each
# button and axis has the number a game expects. The right stick and the
# two stick clicks are there and never move: the phone has one stick.
PAD_KEYS = (BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST, BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR)
PAD_AXES = (
    (ABS_X, -32768, 32767), (ABS_Y, -32768, 32767), (ABS_Z, 0, TRIGGER),
    (ABS_RX, -32768, 32767), (ABS_RY, -32768, 32767), (ABS_RZ, 0, TRIGGER),
    (ABS_HAT0X, -1, 1), (ABS_HAT0Y, -1, 1),
)


def whole(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


class Pad:
    """One phone's controller: it writes what changed between one state
    and the next, as one report. The writer is the uinput file, or a
    stand-in in the unit tests."""

    def __init__(self, write):
        self.write = write
        self.buttons, self.x, self.y = 0, 0, 0

    def set(self, buttons, x, y):
        if not (whole(buttons, 0, (1 << len(PAD_BITS)) - 1) and whole(x, -STICK, STICK) and whole(y, -STICK, STICK)):
            raise ValueError("not a controller's state")
        events = []
        for bit, (kind, code) in enumerate(PAD_BITS):
            down = buttons >> bit & 1
            if down != self.buttons >> bit & 1:
                events.append(event(kind, code, down if kind == EV_KEY else down * TRIGGER))
        # The stick, and the d-pad with it (ADR-115): a game that only reads
        # a d-pad still moves.
        for axis, hat, new, old in ((ABS_X, ABS_HAT0X, x, self.x), (ABS_Y, ABS_HAT0Y, y, self.y)):
            if new != old:
                events.append(event(EV_ABS, axis, new))
            if dpad(new) != dpad(old):
                events.append(event(EV_ABS, hat, dpad(new)))
        self.buttons, self.x, self.y = buttons, x, y
        if events:
            self.write(b"".join(events) + event(EV_SYN, SYN_REPORT, 0))


def dpad(value):
    """Which way the d-pad points for a stick this far along an axis."""
    return (value >= DPAD_FROM) - (value <= -DPAD_FROM)


def create_pad():
    """Makes one controller's uinput device and returns its file descriptor."""
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    try:
        for kind in (EV_KEY, EV_ABS):
            fcntl.ioctl(fd, UI_SET_EVBIT, kind)
        for code in PAD_KEYS:
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        for code, low, high in PAD_AXES:
            fcntl.ioctl(fd, UI_SET_ABSBIT, code)
            # struct uinput_abs_setup: code, then struct input_absinfo.
            fcntl.ioctl(fd, UI_ABS_SETUP, struct.pack("HHiiiiii", code, 0, 0, low, high, 0, 0, 0))
        fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack("HHHH80sI", *PAD_ID, PAD_NAME, 0))
        fcntl.ioctl(fd, UI_DEV_CREATE)
    except OSError:
        os.close(fd)
        raise
    return fd


def make_pad(_slot):
    """A controller on the box: what writes to it, and what takes it away."""
    fd = create_pad()

    def close():
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        finally:
            os.close(fd)

    return (lambda data: os.write(fd, data)), close


class PhonePads:
    """The controllers the daemon asked for, by their number, 1 to 4.

    Each one's guide button has the rule a real controller's has: on_guide
    when it goes down, and on_hold once it has stayed down for hold
    seconds. A controller that goes away takes its hold with it."""

    def __init__(self, make, on_guide, on_hold, hold=GUIDE_HOLD, clock=time.monotonic):
        self.make = make
        self.on_guide = on_guide
        self.on_hold = on_hold
        self.hold = hold
        self.clock = clock
        self.pads = {}
        self.down = {}

    def handle(self, line):
        """Does what one line from the daemon asks, and gives the lines to
        answer with."""
        if not isinstance(line, dict):
            return []
        if "open" in line:
            slot = line["open"]
            if not whole(slot, 1, PAD_MOST):
                return []
            self.close(slot)
            try:
                write, close = self.make(slot)
            except OSError as error:
                return [{"failed": slot, "why": str(error)}]
            self.pads[slot] = (Pad(write), close)
            return [{"opened": slot}]
        if "state" in line:
            state = line["state"]
            if not isinstance(state, list) or len(state) != 4 or not whole(state[0], 1, PAD_MOST) or state[0] not in self.pads:
                return []
            slot, buttons, x, y = state
            pad = self.pads[slot][0]
            was = pad.buttons >> GUIDE_BIT & 1
            try:
                pad.set(buttons, x, y)
            except ValueError:
                return []
            now = buttons >> GUIDE_BIT & 1
            if now and not was:
                # Before on_guide, as for a real controller's.
                self.down[slot] = self.clock()
                self.on_guide()
            elif was and not now:
                self.down.pop(slot, None)
            return [{"took": [slot, line.get("n", 0)]}]
        if "close" in line:
            self.close(line["close"])
        return []

    def close(self, slot):
        if not whole(slot, 1, PAD_MOST):
            return
        found = self.pads.pop(slot, None)
        self.down.pop(slot, None)
        if found:
            try:
                found[1]()
            except OSError:
                pass

    def close_all(self):
        for slot in list(self.pads):
            self.close(slot)

    def wait(self, most=1.0):
        """How long until a held guide button is due, most at the longest."""
        if not self.down:
            return most
        return max(0.0, min(most, min(self.down.values()) + self.hold - self.clock()))

    def tick(self):
        for slot, since in list(self.down.items()):
            if self.clock() - since >= self.hold:
                del self.down[slot]
                self.on_hold()


def daemon_address():
    """Where OrigaiTV's daemon answers this box: 127.0.0.1:3000, or the
    port ORIGAITV_URL or ORIGAITV_PORT names. Never another machine."""
    found = re.fullmatch(r"http://(127\.0\.0\.1|localhost):(\d{1,5})/?", os.environ.get("ORIGAITV_URL", ""))
    if found:
        return "127.0.0.1", int(found.group(2))
    port = os.environ.get("ORIGAITV_PORT", "")
    return "127.0.0.1", int(port) if re.fullmatch(r"\d{1,5}", port) else 3000


# How long the daemon may say nothing before the controllers go: it sends
# a line every two seconds, so this long means it's stuck or gone.
LINK_QUIET = 6.0
# How long before asking again: after the connection ended, and after the
# daemon said no, which it does while game mode's switch is off.
LINK_RETRY = 2.0
LINK_REFUSED = 15.0


def pad_link(address, pads, stop, retry=LINK_RETRY, refused=LINK_REFUSED, quiet=LINK_QUIET, log=print):
    """Holds the daemon's connection for the phones' controllers open until
    stop is set, and makes and moves the controllers it asks for. However
    the connection ends, every controller goes with it."""
    said = None
    while not stop.is_set():
        wait = retry
        try:
            ended = _pad_link(address, pads, stop, quiet)
            if ended == "refused":
                wait = refused
        except (OSError, ValueError) as error:
            ended = f"{error}"
        finally:
            pads.close_all()
        # Once for each reason, not every two seconds while the daemon is
        # down.
        if ended not in (said, "refused", None):
            log(f"origaitv input: the phones' controllers lost the daemon ({ended}); asking again", flush=True)
        said = ended
        stop.wait(wait)


def _pad_link(address, pads, stop, quiet):
    host, port = address
    sock = socket.create_connection(address, timeout=5)
    try:
        sock.sendall(
            f"GET /api/pads HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: Upgrade\r\n"
            "Upgrade: origaitv-pads\r\nX-OrigaiTV-Screen: 1\r\n\r\n".encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(4096)
            if not chunk or len(head) > 65536:
                return "it closed"
            head += chunk
        head, _, held = head.partition(b"\r\n\r\n")
        if not head.startswith(b"HTTP/1.1 101 "):
            return "refused"
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        heard = time.monotonic()
        while not stop.is_set():
            while b"\n" in held:
                line, _, held = held.partition(b"\n")
                try:
                    answers = pads.handle(json.loads(line))
                except (ValueError, TypeError, KeyError):
                    continue
                if answers:
                    sock.sendall(b"".join(json.dumps(answer, separators=(",", ":")).encode() + b"\n" for answer in answers))
            if len(held) > 1 << 20:
                return "a line too long"
            ready, _, _ = select.select([sock], [], [], min(pads.wait(), quiet))
            pads.tick()
            if ready:
                chunk = sock.recv(65536)
                if not chunk:
                    return "it closed"
                held += chunk
                heard = time.monotonic()
            elif time.monotonic() - heard > quiet:
                return "it went quiet"
        return None
    finally:
        sock.close()


def serve_pads(stop, make=make_pad, address=None, **timing):
    """The phones' controllers, until stop is set: the daemon's connection
    held open, and each controller's guide button going home as a real
    one's does. Home waits for the screen daemon, so it's asked from a
    thread of its own, and the next press doesn't wait for it."""
    home = lambda source: threading.Thread(target=screen_home, args=(source,), daemon=True).start()
    pads = PhonePads(make, lambda: home("guide"), lambda: home("guide-hold"))
    pad_link(address or daemon_address(), pads, stop, **timing)


def socket_path(name="input.sock"):
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "origaitv", name)


def gamepads(root="/"):
    """The gamepads there now: the input devices udev marked as joysticks,
    which is how the box check counts them too (daemon/box.ts). That takes
    in a Bluetooth one, which has no link in /dev/input/by-id. The seat's
    user can read them (udev's uaccess), which is how a browser's gamepad
    support works too."""
    found = set()
    for link in glob.glob(os.path.join(root, "dev/input/by-id/*-event-joystick")):
        found.add(os.path.realpath(link))
    for node in glob.glob(os.path.join(root, "sys/class/input/event*")):
        try:
            with open(os.path.join(node, "dev")) as file:
                number = file.read().strip()
            with open(os.path.join(root, "run/udev/data", f"c{number}")) as file:
                marked = "E:ID_INPUT_JOYSTICK=1" in file.read().splitlines()
        except OSError:
            continue
        # A phone's controller is this helper's own: its guide button is
        # timed as it's written (PhonePads), so it isn't read back here.
        try:
            with open(os.path.join(node, "device/name")) as file:
                marked = marked and file.read().strip() != PAD_NAME.decode()
        except OSError:
            pass
        if marked:
            found.add(os.path.join(root, "dev/input", os.path.basename(node)))
    return sorted(found)


def watch_guide(find, on_guide, stop, rescan=3.0, on_hold=None, hold=GUIDE_HOLD):
    """Calls on_guide each time a gamepad's guide button goes down, until
    stop is set, and on_hold once when it has stayed down for hold seconds,
    while it's still down. find lists the devices; it's asked again every
    few seconds, so a gamepad plugged in later counts too.

    Each gamepad's hold is its own, so a tap on a second one doesn't end
    the first one's. A gamepad that goes away takes its hold with it, and so
    does one whose events the kernel dropped, since the release can be among
    them: nothing is left to go home later."""
    fds = {}
    try:
        _watch_guide(fds, find, on_guide, stop, rescan, on_hold, hold)
    finally:
        for fd in fds.values():
            try:
                os.close(fd)
            except OSError:
                pass


def _watch_guide(fds, find, on_guide, stop, rescan, on_hold, hold):
    # When each gamepad's guide button went down, while it's down and its
    # hold hasn't been reported yet.
    down = {}
    scanned = 0.0
    while not stop.is_set():
        if time.monotonic() - scanned >= rescan:
            scanned = time.monotonic()
            for path in find():
                if path not in fds:
                    try:
                        fds[path] = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                    except OSError:
                        pass
        if not fds:
            stop.wait(min(rescan, 0.5))
            continue
        wait = 0.5
        if down:
            wait = max(0.0, min(wait, min(down.values()) + hold - time.monotonic()))
        ready, _, _ = select.select(list(fds.values()), [], [], wait)
        for fd in ready:
            try:
                data = os.read(fd, EVENT_SIZE * 64)
            except BlockingIOError:
                continue
            except OSError:
                data = b""
            if not data:
                # Unplugged.
                for path, open_fd in list(fds.items()):
                    if open_fd == fd:
                        del fds[path]
                down.pop(fd, None)
                os.close(fd)
                continue
            for i in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                _, _, kind, code, value = struct.unpack_from("llHHi", data, i)
                if kind == EV_SYN and code == SYN_DROPPED:
                    down.pop(fd, None)
                elif kind == EV_KEY and code == BTN_MODE and value == 1:
                    # Before on_guide, which waits for the screen daemon.
                    down[fd] = time.monotonic()
                    on_guide()
                elif kind == EV_KEY and code == BTN_MODE and value == 0:
                    down.pop(fd, None)
        # A gamepad with something still to read waits a round: its release
        # may be next.
        for fd, since in list(down.items()):
            if fd not in ready and time.monotonic() - since >= hold:
                del down[fd]
                if on_hold:
                    on_hold()


def keep_watching(watch, stop, pause=1.0, log=print, what="the guide button's watcher"):
    """Runs the guide button's watcher until stop is set. It's a thread
    beside the service's own work, so an error nobody caught would end it
    with the service still up: the guide button and its hold would do
    nothing until the next restart. So after one, it says so and starts
    again. The phones' controllers are kept the same way."""
    while not stop.is_set():
        try:
            watch()
        except Exception as error:  # pylint: disable=broad-except
            log(f"origaitv input: {what} stopped ({error!r}); starting it again", flush=True)
            stop.wait(pause)


def screen_home(source="guide"):
    """Asks the screen daemon for Home, as the guide button: "guide" when
    it goes down, "guide-hold" once it has stayed down. In a game, a press
    of the guide button is the game's own, so the daemon leaves it, and the
    hold goes home."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5)
    try:
        client.connect(socket_path("screen.sock"))
        client.sendall(json.dumps({"cmd": "home", "from": source}, separators=(",", ":")).encode() + b"\n")
        client.recv(4096)
    except OSError as error:
        print(f"origaitv input: Home didn't reach the screen daemon: {error}", flush=True)
    finally:
        client.close()


def answer(device, line):
    """Does one request and says how it went, in one line."""
    try:
        device.handle(json.loads(line))
        return b"ok\n"
    except (ValueError, TypeError, KeyError) as error:
        return f"{error}\n".encode()


def serve():
    fd = create()
    device = Device(lambda data: os.write(fd, data))
    path = socket_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(8)
    print(f"origaitv input: {NAME.decode()} is ready on {path}", flush=True)
    stop = threading.Event()
    watch = lambda: watch_guide(gamepads, screen_home, stop, on_hold=lambda: screen_home("guide-hold"))
    threading.Thread(target=keep_watching, args=(watch, stop), daemon=True).start()
    threading.Thread(target=keep_watching, args=(lambda: serve_pads(stop), stop), kwargs={"what": "the phones' controllers"}, daemon=True).start()
    try:
        while True:
            conn, _ = server.accept()
            with conn, conn.makefile("rwb") as stream:
                stream.write(answer(device, stream.readline()))
    finally:
        stop.set()
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


def send(request):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(socket_path())
    except OSError:
        print("origaitv input: the virtual input device isn't running (no TV session)", file=sys.stderr)
        return 2
    with client, client.makefile("rwb") as stream:
        stream.write(json.dumps(request).encode() + b"\n")
        stream.flush()
        answer = stream.readline().decode().strip()
    if answer != "ok":
        print(f"origaitv input: {answer}", file=sys.stderr)
        return 1
    return 0


def main(args):
    if args[:1] == ["serve"]:
        serve()
        return 0
    if args[:1] == ["key"] and len(args) > 1:
        for name in args[1:]:
            status = send({"key": name})
            if status:
                return status
        return 0
    if args[:1] == ["hold"] and len(args) == 3:
        try:
            ms = round(float(args[2]) * 1000)
        except ValueError:
            ms = -1
        return send({"hold": args[1], "ms": ms})
    if args[:1] == ["text"] and len(args) == 2:
        text = sys.stdin.read().removesuffix("\n") if args[1] == "-" else args[1]
        return send({"text": text})
    if args[:1] == ["move"] and len(args) == 3 and all(re.fullmatch(r"-?\d{1,5}", a) for a in args[1:]):
        return send({"move": [int(args[1]), int(args[2])]})
    if args[:1] == ["click"] and len(args) <= 2:
        return send({"click": args[1] if len(args) == 2 else "left"})
    if args[:1] == ["wheel"] and len(args) == 3 and all(re.fullmatch(r"-?\d{1,4}", a) for a in args[1:]):
        return send({"wheel": [int(args[1]), int(args[2])]})
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
