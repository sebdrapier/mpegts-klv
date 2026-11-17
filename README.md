# mpegts-klv

[![CI](https://github.com/sebdrapier/mpegts-klv/actions/workflows/ci.yml/badge.svg)](https://github.com/sebdrapier/mpegts-klv/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mpegts-klv)](https://www.npmjs.com/package/mpegts-klv)
[![license](https://img.shields.io/npm/l/mpegts-klv)](LICENSE)

Pulls KLV metadata out of MPEG-TS video, from a file or a live stream. This is the telemetry that drones and other STANAG 4609 sources embed next to the video: position, heading, camera angles, and so on.

- **Byte-exact with ffmpeg** on real STANAG 4609 files.
- **Fast**: a 1.2 GB file takes about 0.6 s on Node. Disk speed is the limit.
- **Runs in a Web Worker** so the UI stays responsive. Use one worker per file to process several files in parallel.
- **Streams** (HLS segments, WebSocket, `fetch`): feed chunks of any size as they arrive.
- **Async and sync KLV** (stream_type 0x06 `KLVA` and 0x15), with PTS, including KLV packets split across PES packets or AU cells.
- **Tolerates damaged input**: resyncs after garbage, skips duplicate and scrambled packets, drops PES with lost packets (continuity counter), checks PSI CRCs, follows PMT updates, and reassembles PAT/PMT spanning several packets. 188-, 192- (M2TS) and 204-byte packets.
- **Tells you what went wrong**: `demuxer.stats` counts every problem it worked around.
- Zero dependencies, ESM + CJS.

```sh
npm install mpegts-klv misb0601-parser
```

## Usage

Pair it with [misb0601-parser](https://github.com/sebdrapier/misb0601-parser) to decode MISB ST 0601 packets:

```ts
import { extractKLV } from "mpegts-klv";
import { decode } from "misb0601-parser";

const res = await fetch("/flight.ts");
for await (const { pid, pts, data } of extractKLV(res.body!)) {
  const m = decode(data); // null if it's not ST 0601 or the checksum is wrong
  if (m) console.log(pts, m.sensorLatitude, m.sensorLongitude);
}
```

`extractKLV` accepts a `ReadableStream`, a Node stream (`fs.createReadStream`), or any async iterable of `Uint8Array`.

### In a Web Worker

```ts
import { extractKLVInWorker } from "mpegts-klv";

const worker = new Worker(new URL("mpegts-klv/worker", import.meta.url), { type: "module" });
for await (const k of extractKLVInWorker(worker, file)) {
  // ...
}
worker.terminate();
```

This form is bundled as a worker by Vite and webpack 5. With esbuild or without a bundler, serve `node_modules/mpegts-klv/dist/worker.js` (it is self-contained) and pass its URL to `new Worker(url, { type: "module" })`.

The source can be a `File`/`Blob` or a URL (an HTTP error is thrown, not treated as an empty stream), which are both read inside the worker, or a `ReadableStream`/async iterable, whose chunks are forwarded to the worker. A worker handles one source at a time.

It applies backpressure both ways: a stream is not read further while the worker has 8 chunks waiting, and the worker stops reading a file while 8 batches are waiting for your loop. On `break` or an error the worker stops reading the source, and the same worker can be reused for the next one.

### Pushing chunks yourself

```ts
import { KLVDemuxer } from "mpegts-klv";

const demuxer = new KLVDemuxer();
socket.onmessage = (e) => demuxer.push(new Uint8Array(e.data)).forEach(handle);
// at the end: demuxer.flush().forEach(handle);
```

Successive HLS segments of the same stream can be pushed into one demuxer.

## API

| | |
|---|---|
| `new KLVDemuxer()` | `.push(chunk)` returns the `KLVUnit[]` completed so far; `.flush()` returns the rest at end of input; `.stats` is a `DemuxStats`. |
| `extractKLV(source, demuxer?)` | Async generator of `KLVUnit`. Pass a demuxer to read its `stats` afterwards. |
| `extractKLVInWorker(worker, source, stats?)` | Same, with the work done in a worker created from `mpegts-klv/worker`. `stats` is filled at the end. |
| `splitKLV(bytes)` | Splits concatenated KLV packets. |

`KLVUnit` is `{ pid, pts?, data }`: `pid` is the elementary stream, `pts` is in 90 kHz ticks, and `data` is one complete KLV packet (key + length + value).

A stream is treated as KLV if its PMT entry (or program info) carries a `KLVA` registration or metadata descriptor, as MISB ST 1402 requires. A stream_type 0x06 with no descriptor at all is also tried, for older encoders; only data that starts with a SMPTE key (`06 0E 2B 34`) comes out of it.

`pts` is only present when the PES has one: synchronous KLV always does, asynchronous KLV usually doesn't. It is the raw 33-bit value and wraps after about 26.5 hours.

## License

[MIT](LICENSE)
