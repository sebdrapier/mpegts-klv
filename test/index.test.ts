import { describe, expect, test } from "bun:test";
import { extractKLV, extractKLVInWorker, KLVDemuxer, type KLVUnit, MAX_PENDING, splitKLV } from "../src";

// --- tiny TS muxer for synthetic streams ---
const ccs = new Map<number, number>();
const ts = (pid: number, pusi: boolean, payload: number[]): number[] => {
  const cc = ((ccs.get(pid) ?? -1) + 1) & 15;
  ccs.set(pid, cc);
  const stuffing = 184 - payload.length;
  const head = [0x47, (pusi ? 0x40 : 0) | (pid >> 8), pid & 0xff];
  if (stuffing === 0) return [...head, 0x10 | cc, ...payload];
  const af = stuffing === 1 ? [0] : [stuffing - 1, 0, ...Array(stuffing - 2).fill(0xff)];
  return [...head, 0x30 | cc, ...af, ...payload];
};
/** Independent bitwise MPEG-2 CRC-32, appended to a section. */
const withCrc = (s: number[]) => {
  let c = 0xffffffff;
  for (const b of s) for (let k = 7; k >= 0; k--) c = ((c << 1) ^ (((c >>> 31) ^ (b >> k)) & 1 ? 0x04c11db7 : 0)) >>> 0;
  return [...s, c >>> 24, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
};
const pat = () => ts(0, true, [0, ...withCrc([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00])]);
const pmtSection = (type: number, version = 0, pid = 0x101) =>
  withCrc([0x02, 0xb0, 24, 0, 1, 0xc1 | (version << 1), 0, 0, 0xe1, 0x00, 0xf0, 0, type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 6, 0x05, 4, 0x4b, 0x4c, 0x56, 0x41]);
const pmt = (type: number, version = 0, pid = 0x101) => ts(0x1000, true, [0, ...pmtSection(type, version, pid)]);
const ptsBytes = (p: number) => [0x21 | ((p / 2 ** 29) & 0x0e), (p >> 22) & 0xff, ((p >> 14) & 0xfe) | 1, (p >> 7) & 0xff, ((p << 1) & 0xfe) | 1];
const klv = (n: number, fill: number) => [0x06, 0x0e, 0x2b, 0x34, 2, 0x0b, 1, 1, 0x0e, 1, 3, 1, 1, 0, 0, 0, 0x81, n, ...Array(n).fill(fill)];

/** A PES on PID 0x101 carrying `body`, split into as many TS packets as needed. */
function pes(body: number[], pts: number, pid = 0x101, aligned = true): number[] {
  const bytes = [0, 0, 1, 0xbd, (body.length + 8) >> 8, (body.length + 8) & 0xff, aligned ? 0x84 : 0x80, 0x80, 5, ...ptsBytes(pts), ...body];
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 184) out.push(...ts(pid, i === 0, bytes.slice(i, i + 184)));
  return out;
}

const stream = (type: number, ...pesPackets: number[][]) => new Uint8Array([...pat(), ...pmt(type), ...pesPackets.flat()]);

function run(bytes: Uint8Array, chunk = bytes.length): KLVUnit[] {
  const d = new KLVDemuxer();
  const out: KLVUnit[] = [];
  for (let i = 0; i < bytes.length; i += chunk) out.push(...d.push(bytes.subarray(i, i + chunk)));
  return [...out, ...d.flush()];
}

describe("KLVDemuxer", () => {
  const input = stream(0x06, pes(klv(200, 0xaa), 133200), pes([...klv(3, 1), ...klv(4, 2)], 136800));

  test("async KLV spanning several TS packets, PTS, several KLV per PES", () => {
    const out = run(input);
    expect(out.map((u) => [u.pid, u.pts, u.data.length])).toEqual([
      [0x101, 133200, 218],
      [0x101, 136800, 21],
      [0x101, 136800, 22],
    ]);
    expect(out[0].data).toEqual(new Uint8Array(klv(200, 0xaa)));
  });

  test("same result whatever the chunk size", () => {
    for (const size of [1, 7, 188, 1000]) expect(run(input, size)).toEqual(run(input));
  });

  test("garbage before and between packets is skipped", () => {
    const d = new KLVDemuxer();
    const noisy = new Uint8Array([1, 2, 0x47, 3, ...input.subarray(0, 564), 9, 9, ...input.subarray(564)]);
    expect([...d.push(noisy), ...d.flush()].length).toBe(3);
    expect(d.stats.resyncBytes).toBe(6);
  });

  test("192-byte (M2TS) and 204-byte packets", () => {
    const pad = (n: number, before: boolean) => {
      const out: number[] = [];
      for (let i = 0; i < input.length; i += 188) {
        const pkt = [...input.subarray(i, i + 188)];
        out.push(...(before ? [...Array(n).fill(0), ...pkt] : [...pkt, ...Array(n).fill(0)]));
      }
      return new Uint8Array(out);
    };
    expect(run(pad(4, true))).toEqual(run(input));
    expect(run(pad(16, false))).toEqual(run(input));
  });

  test("a PES is emitted as soon as PES_packet_length is reached", () => {
    const d = new KLVDemuxer();
    expect(d.push(input).length).toBe(3);
  });

  test("duplicate packets are ignored, lost packets drop the PES", () => {
    const pkts = (b: Uint8Array) => Array.from({ length: b.length / 188 }, (_, i) => [...b.subarray(i * 188, i * 188 + 188)]);
    const p = pkts(input); // pat, pmt, pes1 (2 packets), pes2
    const dup = new KLVDemuxer();
    expect([...dup.push(new Uint8Array([...p[0], ...p[1], ...p[2], ...p[2], ...p[3], ...p[4]])), ...dup.flush()].length).toBe(3);
    expect(dup.stats.duplicates).toBe(1);
    const lost = new KLVDemuxer();
    expect([...lost.push(new Uint8Array([...p[0], ...p[1], ...p[2], ...p[4]])), ...lost.flush()].length).toBe(2);
    expect(lost.stats).toMatchObject({ continuityErrors: 1, droppedPes: 1 });
  });

  test("PSI with a bad CRC is rejected", () => {
    const bad = pmt(0x06);
    bad[bad.length - 1] ^= 1;
    const d = new KLVDemuxer();
    expect([...d.push(new Uint8Array([...pat(), ...bad, ...pes(klv(3, 1), 0)])), ...d.flush()]).toEqual([]);
    expect(d.stats.crcErrors).toBe(1);
  });

  test("PMT spanning two TS packets", () => {
    // 200 bytes of program-level private descriptors push the KLV entry into the second packet.
    const info = [0x80, 198, ...Array(198).fill(0x55)];
    const es = [0x06, 0xe1, 0x01, 0xf0, 6, 0x05, 4, 0x4b, 0x4c, 0x56, 0x41];
    const body = [0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0 | (info.length >> 8), info.length & 0xff, ...info, ...es];
    const section = withCrc([0x02, 0xb0 | ((body.length + 4) >> 8), (body.length + 4) & 0xff, ...body]);
    const bytes = [0, ...section]; // pointer_field + section, then 0xFF stuffing
    const raw = (pusi: boolean, b: number[], cc: number) => [0x47, (pusi ? 0x40 : 0) | 0x10, 0x00, 0x10 | cc, ...b, ...Array(184 - b.length).fill(0xff)];
    const out = run(new Uint8Array([...pat(), ...raw(true, bytes.slice(0, 184), 0), ...raw(false, bytes.slice(184), 1), ...pes(klv(3, 1), 0)]));
    expect(out.length).toBe(1);
  });

  test("async KLV packet split over two PES (data_alignment_indicator)", () => {
    const k = klv(250, 9); // klv() writes a 1-byte long-form length
    for (const cut of [2, 10, 100]) {
      const d = new KLVDemuxer();
      const out = [...d.push(stream(0x06, pes(k.slice(0, cut), 1000), pes(k.slice(cut), 2000, 0x101, false))), ...d.flush()];
      expect(out).toEqual([{ pid: 0x101, pts: 1000, data: new Uint8Array(k) }]);
      expect(d.stats.junkBytes).toBe(0);
    }
  });

  test("sync KLV fragmented over two AU cells in two PES", () => {
    const k = klv(50, 4);
    const cell = (frag: number, b: number[]) => [0, 0, (frag << 6) | 0x0f, b.length >> 8, b.length & 0xff, ...b];
    const out = run(stream(0x15, pes(cell(0b10, k.slice(0, 30)), 1000), pes(cell(0b01, k.slice(30)), 1000)));
    expect(out).toEqual([{ pid: 0x101, pts: 1000, data: new Uint8Array(k) }]);
  });

  test("a new aligned PES discards an unfinished packet", () => {
    const d = new KLVDemuxer();
    const out = [...d.push(stream(0x06, pes(klv(50, 1).slice(0, 30), 0), pes(klv(3, 2), 0))), ...d.flush()];
    expect(out.map((u) => u.data.at(-1))).toEqual([2]);
    expect(d.stats.junkBytes).toBe(30);
  });

  test("scrambled packets are dropped", () => {
    const b = stream(0x06, pes(klv(3, 1), 0));
    b[2 * 188 + 3] |= 0x80;
    const d = new KLVDemuxer();
    expect([...d.push(b), ...d.flush()]).toEqual([]);
    expect(d.stats.scrambled).toBe(1);
  });

  test("PMT update moves KLV to another PID", () => {
    const out = run(new Uint8Array([...pat(), ...pmt(0x06), ...pes(klv(3, 1), 0), ...pmt(0x06, 1, 0x102), ...pes(klv(3, 2), 0), ...pes(klv(3, 3), 0, 0x102)]));
    expect(out.map((u) => [u.pid, u.data.at(-1)])).toEqual([[0x101, 1], [0x102, 3]]);
  });

  test("sync KLV (stream_type 0x15) has its AU cell headers removed", () => {
    const k = klv(5, 7);
    const out = run(stream(0x15, pes([0, 0, 0xdf, 0, k.length, ...k], 90000)));
    expect(out).toEqual([{ pid: 0x101, pts: 90000, data: new Uint8Array(k) }]);
  });

  test("streams without a KLVA descriptor are ignored", () => {
    expect(run(new Uint8Array([...pat(), ...pes(klv(3, 1), 0)]))).toEqual([]);
  });
});

test("splitKLV stops at non-KLV bytes", () => {
  expect(splitKLV(new Uint8Array([...klv(2, 5), 0xff, 0xff])).length).toBe(1);
});

test("extractKLV and the worker give the same result", async () => {
  const input = stream(0x06, pes(klv(200, 0xaa), 133200), pes(klv(3, 1), 136800));
  const all = async (it: AsyncIterable<KLVUnit>) => Array.fromAsync(it);
  const expected = await all(extractKLV(new Blob([input]).stream()));
  expect(expected.length).toBe(2);
  for (const source of [new Blob([input]), new Blob([input]).stream()]) {
    const worker = new Worker(new URL("../src/worker.ts", import.meta.url).href, { type: "module" });
    expect(await all(extractKLVInWorker(worker, source))).toEqual(expected);
    worker.terminate();
  }
});

test("backpressure: a slow consumer stops the source from being read ahead", async () => {
  let pulled = 0;
  async function* source() {
    yield new Uint8Array([...pat(), ...pmt(0x06)]);
    for (let i = 0; i < 200; i++) {
      pulled++;
      yield new Uint8Array(pes(klv(3, i & 0xff), 0));
    }
  }
  const worker = new Worker(new URL("../src/worker.ts", import.meta.url).href, { type: "module" });
  const it = extractKLVInWorker(worker, source());
  await it.next();
  await new Promise((r) => setTimeout(r, 200)); // consumer is slow
  expect(pulled).toBeLessThanOrEqual(3 * MAX_PENDING);
  let n = 1;
  for await (const _ of it) n++;
  expect(n).toBe(200);
  worker.terminate();
});

test("backpressure: stopping early stops reading the source", async () => {
  let pulled = 0;
  async function* source() {
    yield new Uint8Array([...pat(), ...pmt(0x06)]);
    for (let i = 0; i < 1000; i++) {
      pulled++;
      yield new Uint8Array(pes(klv(3, 1), 0));
    }
  }
  const worker = new Worker(new URL("../src/worker.ts", import.meta.url).href, { type: "module" });
  for await (const _ of extractKLVInWorker(worker, source())) break;
  await new Promise((r) => setTimeout(r, 100));
  expect(pulled).toBeLessThanOrEqual(3 * MAX_PENDING);
  worker.terminate();
});

/** pat + pmt + n small KLV PES. */
function many(n: number) {
  const out = [...pat(), ...pmt(0x06)];
  for (let i = 0; i < n; i++) out.push(...pes(klv(3, i & 0xff), 0));
  return new Uint8Array(out);
}
const newWorker = () => new Worker(new URL("../src/worker.ts", import.meta.url).href, { type: "module" });
const count = async (it: AsyncIterable<unknown>) => {
  let n = 0;
  for await (const _ of it) n++;
  return n;
};

test("a worker can be reused after break, with a file or a stream", async () => {
  const bytes = many(20_000);
  const worker = newWorker();
  for (const source of [() => new Blob([bytes]), () => new Blob([bytes]).stream()]) {
    for await (const _ of extractKLVInWorker(worker, source())) break;
    expect(await count(extractKLVInWorker(worker, source()))).toBe(20_000);
  }
  worker.terminate();
}, 20_000);

test("a URL that fails to load is an error, not an empty stream", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
  const worker = newWorker();
  expect(count(extractKLVInWorker(worker, server.url.href))).rejects.toThrow("HTTP 404");
  await Bun.sleep(100);
  worker.terminate();
  server.stop();
});

test("a PMT returning after its program left the PAT is applied again", () => {
  const patWithout = ts(0, true, [0, ...withCrc([0x00, 0xb0, 9, 0, 1, 0xc3, 0, 0])]); // version 1, no program
  const patWith = ts(0, true, [0, ...withCrc([0x00, 0xb0, 13, 0, 1, 0xc5, 0, 0, 0, 1, 0xf0, 0x00])]); // version 2
  const out = run(new Uint8Array([...pat(), ...pmt(0x06), ...patWithout, ...patWith, ...pmt(0x06), ...pes(klv(3, 7), 0)]));
  expect(out.map((u) => u.data.at(-1))).toEqual([7]);
});
