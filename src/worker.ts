/**
 * Web Worker script that runs the demuxer off the main thread (browsers, Bun, Deno).
 * Talk to it with `extractKLVInWorker` from the main entry.
 */
import { KLVDemuxer, type KLVUnit, MAX_PENDING, type WorkerMessage, type WorkerRequest } from "./index";

declare const self: {
  onmessage: ((e: { data: WorkerRequest }) => void) | null;
  postMessage(m: WorkerMessage, transfer?: ArrayBuffer[]): void;
};

// State of the current run. A request with another run id starts a new run and abandons the old one.
let run = -1;
let demuxer: KLVDemuxer | null = null; // for chunks pushed by the main thread
let pending = 0; // batches posted but not yet taken by the consumer
let wake: (() => void) | null = null;

function reset(id: number): void {
  run = id;
  demuxer = null;
  pending = 0;
  wake?.(); // lets an abandoned read loop notice and stop
  wake = null;
}

/** Posts a batch, packed into one buffer so it is transferred instead of cloned. */
function send(id: number, units: KLVUnit[]): void {
  if (!units.length) return;
  const buf = new Uint8Array(units.reduce((n, u) => n + u.data.length, 0));
  let o = 0;
  for (const u of units) buf.set(u.data, o), (u.data = buf.subarray(o, (o += u.data.length)));
  pending++;
  self.postMessage({ run: id, units }, [buf.buffer]);
}

async function readSource(id: number, src: Blob | string): Promise<void> {
  let stream: ReadableStream<Uint8Array>;
  if (typeof src === "string") {
    const res = await fetch(src);
    if (!res.ok || !res.body) throw new Error(`fetch ${src}: HTTP ${res.status}`);
    stream = res.body;
  } else stream = src.stream();
  const reader = stream.getReader();
  const d = new KLVDemuxer();
  try {
    for (;;) {
      while (run === id && pending >= MAX_PENDING) await new Promise<void>((r) => (wake = r)); // consumer is behind
      if (run !== id) return; // cancelled or replaced
      const r = await reader.read();
      if (run !== id) return;
      if (r.done) break;
      send(id, d.push(r.value));
    }
    send(id, d.flush());
    self.postMessage({ run: id, done: d.stats });
  } finally {
    reader.cancel().catch(() => {});
  }
}

self.onmessage = async ({ data: req }) => {
  if ("cancel" in req) {
    if (req.run === run) reset(-1);
    return;
  }
  if (req.run !== run) {
    if ("consumed" in req) return; // late message from an abandoned run
    reset(req.run);
  }
  const id = req.run;
  try {
    if ("consumed" in req) {
      pending--;
      return wake?.();
    }
    if ("chunk" in req) {
      send(id, (demuxer ??= new KLVDemuxer()).push(req.chunk));
      return self.postMessage({ run: id, chunkDone: true });
    }
    if ("end" in req) {
      const d = demuxer ?? new KLVDemuxer();
      send(id, d.flush());
      demuxer = null;
      return self.postMessage({ run: id, done: d.stats });
    }
    await readSource(id, req.source);
  } catch (e) {
    if (run === id) self.postMessage({ run: id, error: String(e) });
  }
};
