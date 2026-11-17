/**
 * Extracts KLV metadata (SMPTE 336 / MISB ST 0601…) from MPEG-TS, as a file or a stream.
 * Zero dependencies. Handles async (stream_type 0x06, "KLVA") and sync (stream_type 0x15) KLV,
 * 188/192/204-byte packets, multi-packet PSI with CRC, PMT updates and continuity errors.
 */

export interface KLVUnit {
  /** Elementary stream PID the packet came from. */
  pid: number;
  /** PES presentation time in 90 kHz ticks (33-bit, wraps every ~26.5 h), if the PES carried one. */
  pts?: number;
  /** One complete KLV packet: 16-byte key + BER length + value. */
  data: Uint8Array;
}

/** What went wrong in the input. All zero on a clean stream. */
export interface DemuxStats {
  /** TS packets read. */
  packets: number;
  /** Bytes skipped while looking for packet sync. */
  resyncBytes: number;
  /** Packets dropped because transport_error_indicator was set. */
  transportErrors: number;
  /** Packets dropped because they are scrambled (encrypted). */
  scrambled: number;
  /** Repeated packets (same continuity counter) that were ignored. */
  duplicates: number;
  /** Continuity counter gaps, i.e. lost packets, on PSI or KLV PIDs. */
  continuityErrors: number;
  /** PSI sections rejected for a bad CRC. */
  crcErrors: number;
  /** KLV PES dropped: lost packets, no start code, or over 1 MB without an end. */
  droppedPes: number;
  /** Bytes in KLV payloads that were not part of a complete KLV packet. */
  junkBytes: number;
}

const PKT = 188;
const STRIDES = [188, 192, 204]; // plain TS, M2TS/BDAV (4-byte prefix), TS + 16-byte Reed-Solomon
const MAX_PES = 1 << 20;
const KLVA = [0x4b, 0x4c, 0x56, 0x41];

interface Pes {
  parts: Uint8Array[];
  size: number;
  /** Total bytes from PES_packet_length, or 0 when unbounded. */
  want: number;
}

interface KlvStream {
  /** stream_type 0x15: payload is wrapped in metadata AU cells. */
  sync: boolean;
  pes: Pes | null;
  /** Start of a KLV packet that continues in the next PES. */
  carry: { data: Uint8Array; pts?: number } | null;
}

/**
 * Push-based demuxer: feed it chunks of any size, it returns the KLV packets completed so far.
 * A PES is emitted as soon as it is complete (PES_packet_length), or at the next one when its length is 0.
 *
 * ```ts
 * const d = new KLVDemuxer();
 * for await (const chunk of stream) for (const k of d.push(chunk)) use(k);
 * for (const k of d.flush()) use(k);
 * console.log(d.stats);
 * ```
 */
export class KLVDemuxer {
  readonly stats: DemuxStats = {
    packets: 0,
    resyncBytes: 0,
    transportErrors: 0,
    scrambled: 0,
    duplicates: 0,
    continuityErrors: 0,
    crcErrors: 0,
    droppedPes: 0,
    junkBytes: 0,
  };
  private stride = 0;
  private synced = false;
  private rest: Uint8Array | null = null;
  private cc = new Map<number, number>();
  private psi = new Map<number, Uint8Array>(); // PID → partial section
  private lastCrc = new Map<number, number>(); // PID → CRC of the last section applied
  private pmtPids = new Set<number>();
  private programs = new Map<number, Map<number, boolean>>(); // program_number → (KLV PID → sync)
  private klv = new Map<number, KlvStream>();

  push(chunk: Uint8Array): KLVUnit[] {
    const out: KLVUnit[] = [];
    let buf = chunk;
    if (this.rest) buf = concat([this.rest, chunk], this.rest.length + chunk.length); // ponytail: copies the chunk; fine at >1 GB/s
    const i = this.run(buf, false, out);
    this.rest = i < buf.length ? buf.slice(i) : null;
    return out;
  }

  /** Emits what is still buffered. Call once at end of input. */
  flush(): KLVUnit[] {
    const out: KLVUnit[] = [];
    if (this.rest) this.run(this.rest, true, out);
    this.rest = null;
    for (const [pid, st] of this.klv) {
      if (st.pes) this.emit(pid, st, out);
      if (st.carry) (this.stats.junkBytes += st.carry.data.length), (st.carry = null);
    }
    return out;
  }

  /** Reads packets from `buf`, returns the index of the first byte not consumed. */
  private run(buf: Uint8Array, final: boolean, out: KLVUnit[]): number {
    let i = 0;
    while (i + PKT <= buf.length) {
      if (!this.synced) {
        const s = this.detect(buf, i, final);
        if (s < 0) break;
        if (s === 0) {
          i++;
          this.stats.resyncBytes++;
          continue;
        }
        this.stride = s;
        this.synced = true;
      } else if (buf[i] !== 0x47) {
        this.synced = false;
        continue;
      }
      if (i + this.stride > buf.length && !final) break;
      this.packet(buf.subarray(i, i + PKT), out);
      i += this.stride;
    }
    return i;
  }

  /** Stride if `i` starts a run of 3 packets, 0 if not, -1 if more data is needed to tell. */
  private detect(buf: Uint8Array, i: number, final: boolean): number {
    if (buf[i] !== 0x47 || !(buf[i + 3] & 0x30)) return 0; // adaptation_field_control 00 is reserved
    for (const s of this.stride ? [this.stride] : STRIDES) {
      if (i + 2 * s >= buf.length && !final) return -1;
      if ((buf[i + s] ?? 0x47) === 0x47 && (buf[i + 2 * s] ?? 0x47) === 0x47) return s;
    }
    return 0;
  }

  private packet(p: Uint8Array, out: KLVUnit[]): void {
    this.stats.packets++;
    if (p[1] & 0x80) {
      this.stats.transportErrors++;
      return;
    }
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const st = this.klv.get(pid);
    if (!st && pid !== 0 && !this.pmtPids.has(pid)) return;
    const afc = (p[3] >> 4) & 3;
    if (!(afc & 1)) return; // no payload: continuity_counter does not advance
    if (p[3] & 0xc0) {
      this.stats.scrambled++;
      return;
    }
    const cc = p[3] & 0x0f;
    const last = this.cc.get(pid);
    this.cc.set(pid, cc);
    const discontinuity = afc & 2 && p[4] > 0 && p[5] & 0x80;
    if (last !== undefined && !discontinuity) {
      if (cc === last) {
        this.stats.duplicates++;
        return;
      }
      if (cc !== ((last + 1) & 0x0f)) {
        this.stats.continuityErrors++;
        this.psi.delete(pid);
        if (st?.pes) (st.pes = null), this.stats.droppedPes++;
        if (st?.carry) (this.stats.junkBytes += st.carry.data.length), (st.carry = null);
      }
    }
    const start = afc & 2 ? 5 + p[4] : 4;
    if (start >= PKT) return;
    const payload = p.subarray(start);
    const pusi = (p[1] & 0x40) !== 0;
    if (st) this.pesData(pid, st, pusi, payload, out);
    else this.psiData(pid, pusi, payload);
  }

  private pesData(pid: number, st: KlvStream, pusi: boolean, payload: Uint8Array, out: KLVUnit[]): void {
    if (pusi) {
      if (st.pes) this.emit(pid, st, out);
      const len = payload.length >= 6 ? (payload[4] << 8) | payload[5] : 0;
      st.pes = { parts: [payload], size: payload.length, want: len && 6 + len };
    } else if (st.pes) {
      st.pes.parts.push(payload);
      st.pes.size += payload.length;
    } else return;
    if (st.pes.want && st.pes.size >= st.pes.want) this.emit(pid, st, out);
    else if (st.pes.size > MAX_PES) (st.pes = null), this.stats.droppedPes++;
  }

  private emit(pid: number, st: KlvStream, out: KLVUnit[]): void {
    const buf = concat(st.pes!.parts, st.pes!.size);
    st.pes = null;
    if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) {
      this.stats.droppedPes++;
      return;
    }
    const pesLen = (buf[4] << 8) | buf[5];
    const end = pesLen ? Math.min(buf.length, 6 + pesLen) : buf.length;
    const pts =
      buf[7] & 0x80 && buf[8] >= 5 && buf.length >= 14
        ? (buf[9] & 0x0e) * 2 ** 29 + buf[10] * 2 ** 22 + (buf[11] & 0xfe) * 2 ** 14 + buf[12] * 2 ** 7 + (buf[13] >> 1)
        : undefined;
    let data = buf.subarray(Math.min(9 + buf[8], end), end);
    // Does this PES start a new KLV packet? Sync: cell_fragment_indication 11 or 10. Async: data_alignment_indicator.
    const aligned = st.sync ? data.length < 3 || (data[2] & 0x80) !== 0 : (buf[6] & 0x04) !== 0;
    if (st.sync) data = stripAuCells(data);
    let ptsOut = pts;
    if (st.carry) {
      if (!aligned && !isUL(data, 0)) {
        data = concat([st.carry.data, data], st.carry.data.length + data.length);
        ptsOut = st.carry.pts;
      } else this.stats.junkBytes += st.carry.data.length;
      st.carry = null;
    }
    const { packets, tail } = split(data);
    const startPts = ptsOut;
    let used = 0;
    for (const k of packets) {
      used += k.length;
      out.push(ptsOut === undefined ? { pid, data: k } : { pid, pts: ptsOut, data: k });
      ptsOut = pts; // only the first packet can come from the previous PES
    }
    if (tail < data.length && data.length - tail <= MAX_PES) {
      st.carry = { data: data.slice(tail), pts: tail === 0 ? startPts : pts };
      used += data.length - tail;
    }
    this.stats.junkBytes += data.length - used;
  }

  private psiData(pid: number, pusi: boolean, payload: Uint8Array): void {
    let buf = this.psi.get(pid);
    if (pusi) {
      const ptr = 1 + payload[0];
      if (buf) this.sections(pid, concat([buf, payload.subarray(1, ptr)], buf.length + ptr - 1)); // end of previous section
      buf = payload.subarray(ptr);
    } else if (buf) buf = concat([buf, payload], buf.length + payload.length);
    else return;
    const rest = this.sections(pid, buf);
    if (rest) this.psi.set(pid, rest);
    else this.psi.delete(pid);
  }

  /** Applies every complete section in `buf`, returns the incomplete tail (copied), if any. */
  private sections(pid: number, buf: Uint8Array): Uint8Array | undefined {
    while (buf.length && buf[0] !== 0xff) {
      if (buf.length < 3) return buf.slice();
      const len = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
      if (buf.length < len) return len > 1024 + 3 ? undefined : buf.slice(); // PAT/PMT sections are at most 1024 bytes
      this.section(pid, buf.subarray(0, len));
      buf = buf.subarray(len);
    }
  }

  private section(pid: number, s: Uint8Array): void {
    if (s.length < 12) return;
    if (crc32(s) !== 0) {
      this.stats.crcErrors++;
      return;
    }
    if (!(s[5] & 1)) return; // current_next_indicator = 0: not applicable yet
    const crc = ((s[s.length - 4] << 24) | (s[s.length - 3] << 16) | (s[s.length - 2] << 8) | s[s.length - 1]) >>> 0;
    if (this.lastCrc.get(pid) === crc) return; // same table again
    this.lastCrc.set(pid, crc);
    const body = s.subarray(8, s.length - 4);
    if (pid === 0 && s[0] === 0x00) this.pat(body);
    else if (s[0] === 0x02) this.pmt((s[3] << 8) | s[4], body);
  }

  // ponytail: a PAT split over several sections (section_number > 0) only keeps the last one; real streams use one.
  private pat(body: Uint8Array): void {
    const programs = new Set<number>();
    this.pmtPids.clear();
    for (let i = 0; i + 4 <= body.length; i += 4) {
      const program = (body[i] << 8) | body[i + 1];
      if (program === 0) continue; // network PID
      programs.add(program);
      this.pmtPids.add(((body[i + 2] & 0x1f) << 8) | body[i + 3]);
    }
    for (const p of this.programs.keys()) if (!programs.has(p)) this.programs.delete(p);
    for (const pid of this.lastCrc.keys()) if (pid !== 0) this.lastCrc.delete(pid); // re-apply PMTs, even identical ones
    this.rebuild();
  }

  private pmt(program: number, body: Uint8Array): void {
    const infoLen = ((body[2] & 0x0f) << 8) | body[3];
    const programKLVA = hasKLVA(body.subarray(4, 4 + infoLen));
    const streams = new Map<number, boolean>();
    for (let i = 4 + infoLen; i + 5 <= body.length; ) {
      const type = body[i];
      const pid = ((body[i + 1] & 0x1f) << 8) | body[i + 2];
      const esLen = ((body[i + 3] & 0x0f) << 8) | body[i + 4];
      const klva = programKLVA || hasKLVA(body.subarray(i + 5, i + 5 + esLen));
      // Some older encoders send 0x06 with no descriptor at all; splitKLV only keeps real KLV from those.
      if ((type === 0x06 || type === 0x15) && (klva || (type === 0x06 && esLen === 0))) streams.set(pid, type === 0x15);
      i += 5 + esLen;
    }
    this.programs.set(program, streams);
    this.rebuild();
  }

  /** Recomputes the KLV PIDs after a PAT/PMT change, keeping the PES in progress on PIDs that did not change. */
  private rebuild(): void {
    const next = new Map<number, KlvStream>();
    for (const streams of this.programs.values())
      for (const [pid, sync] of streams) {
        const cur = this.klv.get(pid);
        next.set(pid, cur?.sync === sync ? cur : { sync, pes: null, carry: null });
      }
    this.klv = next;
  }
}

/** True if the descriptors contain "KLVA" (registration descriptor 0x05 or metadata descriptor 0x26). */
function hasKLVA(d: Uint8Array): boolean {
  for (let i = 0; i + 4 <= d.length; i++)
    if (d[i] === KLVA[0] && d[i + 1] === KLVA[1] && d[i + 2] === KLVA[2] && d[i + 3] === KLVA[3]) return true;
  return false;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

/** MPEG-2 CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection). 0 over a section that includes its CRC. */
function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = (c << 8) ^ CRC_TABLE[((c >>> 24) ^ d[i]) & 0xff];
  return c >>> 0;
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const buf = new Uint8Array(size);
  let o = 0;
  for (const p of parts) buf.set(p, o), (o += p.length);
  return buf;
}

/** Sync KLV (ISO 13818-1 metadata AU cells): 5-byte cell header + data, repeated. */
function stripAuCells(d: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; i + 5 <= d.length; ) {
    const len = (d[i + 3] << 8) | d[i + 4];
    parts.push(d.subarray(i + 5, i + 5 + len));
    size += Math.min(len, d.length - i - 5);
    i += 5 + len;
  }
  return concat(parts, size);
}

const isUL = (d: Uint8Array, i: number) => d[i] === 0x06 && d[i + 1] === 0x0e && d[i + 2] === 0x2b && d[i + 3] === 0x34;

/**
 * Finds complete KLV packets (starting with a SMPTE UL, 06 0E 2B 34) and skips anything else.
 * `tail` is where a truncated packet at the end starts (its rest may be in the next PES), or `d.length`.
 */
function split(d: Uint8Array): { packets: Uint8Array[]; tail: number } {
  const packets: Uint8Array[] = [];
  let tail = d.length;
  for (let i = 0; i + 4 <= d.length; ) {
    if (!isUL(d, i)) {
      i++;
      continue;
    }
    let len = i + 17 <= d.length ? d[i + 16] : -2;
    let v = i + 17;
    if (len > 0x80) {
      const n = len & 0x7f;
      len = n > 4 ? -1 : v + n > d.length ? -2 : 0;
      for (let j = 0; len >= 0 && j < n; j++) len = len * 256 + d[v + j];
      v += n;
    } else if (len === 0x80) len = -1; // indefinite length is not allowed in KLV
    if (len === -2 || (len >= 0 && v + len > d.length)) {
      if (tail === d.length) tail = i; // truncated: may continue in the next PES
      i++;
      continue;
    }
    if (len < 0) {
      i++;
      continue;
    }
    packets.push(d.subarray(i, v + len));
    tail = d.length;
    i = v + len;
  }
  // A key cut in its first 4 bytes.
  for (let k = Math.max(0, d.length - 3); tail === d.length && k < d.length; k++)
    if ([0x06, 0x0e, 0x2b].every((b, j) => k + j >= d.length || d[k + j] === b)) tail = k;
  return { packets, tail };
}

/** Splits concatenated KLV packets. Bytes that are not a complete packet starting with a SMPTE UL are skipped. */
export function splitKLV(d: Uint8Array): Uint8Array[] {
  return split(d).packets;
}

/** Extracts every KLV packet from a TS stream (a `ReadableStream`, Node stream or any async iterable of bytes). */
export async function* extractKLV(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  /** Pass your own to read its `stats` afterwards. */
  d: KLVDemuxer = new KLVDemuxer(),
): AsyncGenerator<KLVUnit> {
  for await (const chunk of iterate(source)) yield* d.push(chunk);
  yield* d.flush();
}

async function* iterate(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  if (!("getReader" in source)) return yield* source; // some browsers' ReadableStream isn't async-iterable yet
  const reader = source.getReader();
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) yield r.value;
  } finally {
    reader.releaseLock();
  }
}

/** A `Blob`/`File` or URL is read inside the worker. A stream is read here and its chunks are posted to the worker. */
export type WorkerSource = Blob | string | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
/** Messages between `extractKLVInWorker` and the worker. Every message carries the id of the run it belongs to. */
export type WorkerRequest = { run: number } & (
  | { source: Blob | string }
  | { chunk: Uint8Array }
  | { end: true }
  | { consumed: true }
  | { cancel: true }
);
export type WorkerMessage = { run: number } & ({ units: KLVUnit[] } | { chunkDone: true } | { done: DemuxStats } | { error: string });

let nextRun = 0;

/** Backpressure: at most this many chunks sent to the worker but not processed, or batches sent back but not consumed. */
export const MAX_PENDING = 8;

/** The parts of a `Worker` this library uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: "message", listener: (e: { data: WorkerMessage }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: WorkerMessage }) => void): void;
}

/**
 * Runs the extraction in a worker created from `mpegts-klv/worker`. One source at a time per worker;
 * use several workers to process several files in parallel.
 *
 * ```ts
 * const worker = new Worker(new URL("mpegts-klv/worker", import.meta.url), { type: "module" });
 * for await (const k of extractKLVInWorker(worker, file)) use(k);
 * ```
 */
export async function* extractKLVInWorker(
  worker: WorkerLike,
  source: WorkerSource,
  /** Filled with the demuxer's stats when the source ends. */
  stats?: DemuxStats,
): AsyncGenerator<KLVUnit> {
  const run = nextRun++;
  const queue: WorkerMessage[] = [];
  let inFlight = 0; // chunks posted to the worker and not processed yet
  let wakeConsumer = null as (() => void) | null;
  let wakePump = null as (() => void) | null;
  let finished = false as boolean;
  const onMessage = (e: { data: WorkerMessage }) => {
    if (e.data.run !== run) return; // from an earlier run on the same worker
    if ("chunkDone" in e.data) inFlight--, wakePump?.();
    else queue.push(e.data), wakeConsumer?.();
  };
  worker.addEventListener("message", onMessage);
  try {
    if (typeof source === "string" || source instanceof Blob) worker.postMessage({ run, source });
    else
      void (async () => {
        try {
          for await (const chunk of iterate(source)) {
            // Wait while the worker is behind, or the consumer of this generator is.
            while (!finished && (inFlight >= MAX_PENDING || queue.length >= MAX_PENDING)) await new Promise<void>((r) => (wakePump = r));
            wakePump = null;
            if (finished) return;
            inFlight++;
            const copy = chunk.slice(); // own buffer: transferring it neither copies a larger backing buffer nor detaches the caller's
            worker.postMessage({ run, chunk: copy }, [copy.buffer]);
          }
          if (!finished) worker.postMessage({ run, end: true });
        } catch (e) {
          onMessage({ data: { run, error: String(e) } });
        }
      })();
    for (;;) {
      if (!queue.length) await new Promise<void>((r) => (wakeConsumer = r));
      wakeConsumer = null;
      const m = queue.shift()!;
      wakePump?.();
      if ("error" in m) throw new Error(m.error);
      if ("done" in m) {
        finished = true;
        if (stats) Object.assign(stats, m.done);
        return;
      }
      if ("units" in m) {
        worker.postMessage({ run, consumed: true });
        yield* m.units;
      }
    }
  } finally {
    if (!finished) worker.postMessage({ run, cancel: true }); // break, throw or error: stop the worker's work for this run
    finished = true;
    wakePump?.();
    worker.removeEventListener("message", onMessage);
  }
}
