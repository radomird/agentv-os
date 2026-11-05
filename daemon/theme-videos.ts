// The Omarchy theme's videos for the TV (ADR-064): its video backgrounds,
// which loop, and its intros, which play once and end on their still.
//
// They stay where Omarchy keeps them, in the person's own folders, and are
// never copied. The daemon can't read those folders, so the TV session,
// which can, serves each video it found on a port of its own on 127.0.0.1,
// under a random path, with range requests so a video element can seek and
// loop. The daemon streams them on to home from its own address, so home's
// page only ever loads from the daemon.
//
// This also has what the TV session finds out about a video with Omarchy's
// own ffmpeg: its codec and size, so home plays it only where the box
// decodes that codec in hardware, and its first frame, which is the still
// it shows otherwise.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// What home's Chromium plays of the kinds Omarchy takes as a background.
// Omarchy takes .avi too, which Chromium doesn't play, so an AVI background
// shows its still.
export type VideoType = "video/mp4" | "video/webm" | "video/x-matroska";
export const VIDEO_TYPES: Record<string, VideoType> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" };
// Every kind Omarchy finds as a background or an intro, in the order its
// omarchy-theme-bg-boot-intro looks for an intro.
export const OMARCHY_VIDEO = ["mp4", "m4v", "mov", "webm", "mkv", "avi"];

// A video's codec as ffprobe names it (h264, hevc, vp9, av1), and its size.
export interface VideoInfo {
  codec: string | null;
  width: number | null;
  height: number | null;
}

export function videoType(path: string): VideoType | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (extension && VIDEO_TYPES[extension]) || null;
}

export function isOmarchyVideo(path: string): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return Boolean(extension && OMARCHY_VIDEO.includes(extension));
}

// A video's id, from where it is, its size and its time: reading a whole
// video to name it would take a while, and nothing of it is kept anyway.
export function videoId(path: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${path}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 16);
}

// ffprobe's codec and size for a video's first video stream, or null.
export function probe(path: string): Promise<VideoInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", path],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const stream = JSON.parse(stdout)?.streams?.[0];
          if (!stream) return resolve(null);
          const codec = typeof stream.codec_name === "string" && /^[a-z0-9_]{1,20}$/.test(stream.codec_name) ? stream.codec_name : null;
          const size = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 16384 ? (value as number) : null);
          resolve({ codec, width: size(stream.width), height: size(stream.height) });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// A video's first frame as a JPEG, for its still, or null.
export function firstFrame(path: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", path, "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
      { timeout: 30_000, maxBuffer: 15 * 1024 * 1024, encoding: "buffer" },
      (error, stdout) => resolve(!error && stdout.length > 3 && stdout[0] === 0xff && stdout[1] === 0xd8 ? stdout : null),
    );
  });
}

interface Served {
  path: string;
  type: VideoType;
}

// A part of a file, as a Range header asks for it, or the whole of it.
// Null when the range can't be met.
export function byteRange(header: unknown, size: number): { start: number; end: number; partial: boolean } | null {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? ""));
  if (!range || (!range[1] && !range[2])) return { start: 0, end: size - 1, partial: false };
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) return null;
  return { start, end, partial: true };
}

// The TV session's side: the videos it found, each at /<token>/<id> on a
// port of its own on 127.0.0.1, and nothing else.
export class VideoServer {
  readonly token = randomBytes(16).toString("hex");
  private files = new Map<string, Served>();
  private server: Server;
  private base: string | null = null;

  constructor() {
    this.server = createServer((request, response) => void this.serve(request, response));
  }

  // Where the daemon finds them: http://127.0.0.1:<port>/<token>/.
  async listen(): Promise<string> {
    if (this.base) return this.base;
    const port = await new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port));
    });
    this.base = `http://127.0.0.1:${port}/${this.token}/`;
    return this.base;
  }

  // The videos there are now, by id. Any other id is gone.
  offer(files: Map<string, Served>): void {
    this.files = new Map(files);
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/([0-9a-f]{32})\/([0-9a-f]{16})$/.exec(request.url ?? "");
    const file = match && match[1] === this.token ? this.files.get(match[2]) : undefined;
    if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("not here\n");
      return;
    }
    const info = await stat(file.path).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("not here\n");
      return;
    }
    const range = byteRange(request.headers.range, info.size);
    if (!range) {
      response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
      return;
    }
    const headers: Record<string, string | number> = {
      "Content-Type": file.type,
      "Accept-Ranges": "bytes",
      "Content-Length": range.end - range.start + 1,
      // Home's Chromium keeps what it read, so a loop doesn't read it again.
      "Cache-Control": "private, max-age=3600",
      ETag: `"${match![2]}"`,
      "Last-Modified": info.mtime.toUTCString(),
    };
    if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.size}`;
    response.writeHead(range.partial ? 206 : 200, headers);
    if (request.method === "HEAD" || info.size === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(file.path, { start: range.start, end: range.end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }
}

// Where the TV session said it serves them: only 127.0.0.1, on a port of
// its own, under a random path.
export const SERVE = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/[0-9a-f]{32}\/$/;

export function cleanServe(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SERVE.exec(value);
  return match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 ? value : null;
}

// The daemon's side: one of them from the TV session to home, the part home
// asked for, as it comes. Only a video goes through.
const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"];

export function streamVideo(base: string, id: string, request: IncomingMessage, response: ServerResponse): void {
  const fail = (status: number, error: string) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = JSON.stringify({ ok: false, error });
    response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }).end(body);
  };
  const headers: Record<string, string> = {};
  if (typeof request.headers.range === "string") headers.Range = request.headers.range;
  const upstream = httpRequest(`${base}${id}`, { method: request.method === "HEAD" ? "HEAD" : "GET", headers, timeout: 10_000 }, (answer) => {
    const status = answer.statusCode ?? 502;
    const video = /^video\//.test(String(answer.headers["content-type"] ?? ""));
    if (status === 416) {
      answer.resume();
      response.writeHead(416, { "Content-Range": String(answer.headers["content-range"] ?? "") }).end();
      return;
    }
    if ((status !== 200 && status !== 206) || !video) {
      answer.resume();
      fail(status === 404 ? 404 : 502, status === 404 ? "that video isn't there any more" : "the tv session didn't send that video");
      return;
    }
    const passed: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
    for (const name of PASS) {
      const value = answer.headers[name];
      if (typeof value === "string") passed[name] = value;
    }
    response.writeHead(status, passed);
    answer.on("error", () => response.destroy());
    answer.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
  upstream.on("error", () => fail(502, "the tv session isn't serving its videos"));
  response.on("close", () => upstream.destroy());
  upstream.end();
}
