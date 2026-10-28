// The test TV's photos and music (builder/prompts/tests.md): one share with
// a few photos in two folders, and an album of two short tracks, answered
// as the TV session answers the kit's media calls. Nothing on the box is
// read: a built app's test sees these, never the household's own.

import { crc32, deflateSync } from "node:zlib";
import type { Album, MediaSource, Photo, PhotoPage } from "../../apps/contract/kit.ts";

const SOURCE: MediaSource = { id: "test-share", name: "Test share", kind: "share" };
const FOLDERS = ["Garden", "Holiday"];
const PHOTOS: Photo[] = FOLDERS.flatMap((folder, f) =>
  [1, 2, 3].map((n) => ({ id: `test-share:${folder}/${n}.png`, name: `${n}.png`, folder, modified: `2026-0${f + 5}-0${n}T10:00:00Z` })),
);

// A small PNG of one colour, a colour a photo, enough for an <img> to load.
function png(seed: number): string {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const size = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const colour = [(seed * 70) % 256, (seed * 130 + 60) % 256, (seed * 40 + 120) % 256];
  const row = Buffer.from([0, ...Array.from({ length: size }, () => colour).flat()]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

// Half a second of silence, as a WAV.
function wav(): string {
  const rate = 8000;
  const samples = rate / 2;
  const data = Buffer.alloc(samples, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString("base64");
}

const ALBUM: Album = {
  id: "test-album",
  title: "Test album",
  artist: "Test artist",
  tracks: [
    { id: "test-album:1", title: "First", artist: "Test artist", album: "Test album", seconds: 1 },
    { id: "test-album:2", title: "Second", artist: "Test artist", album: "Test album", seconds: 1 },
  ],
};

function list(args: unknown[]): PhotoPage {
  const [source, options] = args as [string, { folder?: string; offset?: number; limit?: number } | undefined];
  if (source !== SOURCE.id) throw new Error("there's no such source");
  const folder = options?.folder ?? "";
  const offset = Math.max(0, Number(options?.offset ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50) || 50));
  const here = PHOTOS.filter((photo) => photo.folder === folder);
  return { folders: folder === "" ? FOLDERS : [], photos: here.slice(offset, offset + limit), total: here.length };
}

export const media = new Map<string, (args: unknown[]) => unknown>([
  ["photos.sources", () => [SOURCE]],
  ["photos.list", list],
  [
    "photos.image",
    (args) => {
      const photo = PHOTOS.find((p) => p.id === args[0]);
      if (!photo) throw new Error("there's no such photo");
      return { type: "image/png", bytes: png(PHOTOS.indexOf(photo)) };
    },
  ],
  ["music.albums", () => [ALBUM]],
  [
    "music.track",
    (args) => {
      if (!ALBUM.tracks.some((track) => track.id === args[0])) throw new Error("there's no such track");
      return { type: "audio/wav", bytes: wav() };
    },
  ],
]);
