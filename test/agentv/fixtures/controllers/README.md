# Stand-ins for Bluetooth

`objects.json` is what `busctl --system --json=short call org.bluez / org.freedesktop.DBus.ObjectManager GetManagedObjects` prints: one adapter, a few controllers, and the things that must never show in Settings (a keyboard, a mouse, headphones, a phone, something with no name). It's written by hand in busctl's shape, with the classes and appearances those kinds of devices send. It wasn't recorded from a box.

`bluez.mts` answers the same commands from memory, for the tests that pair and remove.
