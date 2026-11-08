# What servers and shares say on a home network

The answers the box hears when it looks for servers and shares, for the tests in `test/agentv/unit/discover.test.mts`. Nothing here is from anyone's real network: the names and addresses are made up.

Recorded from the real thing, on Ubuntu 24.04's own packages:

- `smbclient-list.txt`, `smbclient-login.txt` and `smbclient-away.txt`: what `smbclient -L //nas -N -g` (Samba 4.19.5) printed for a Samba that lists its shares to a guest, one that wants a user name first, and nothing listening.
- `wsdd-probe-match.xml`, `wsdd-resolve-match.xml` and `wsdd-get.xml`: wsdd 0.7.1's answers to the box's own Probe, Resolve and Get, from wsdd's own handlers. That's what a Linux NAS running wsdd says. It leaves its address out of the first answer, so the box asks for it.
- `avahi-smb.txt` and `avahi-nfs.txt`: `avahi-browse --parsable --resolve` (Avahi 0.8) for a machine announcing an SMB share and an NFS export, on a network of its own.
- `rpcbind-getport.hex` and `mountd-export.hex`: rpcbind's and rpc.mountd's replies (nfs-utils 2.6.4) to the box's two calls for a server's NFS exports, as hex.

Written by hand from what each server sends, since I couldn't run them here:

- `jellyfin-7359.json` and `emby-7359.json`: Jellyfin's and Emby's answers on UDP 7359.
- `plex-gdm.txt`: Plex's answer to GDM's M-SEARCH.
- `immich-ping.json`: Immich's answer at `/api/server/ping`.
