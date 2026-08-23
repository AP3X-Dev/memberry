import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
const archive = new Uint8Array(await readFile(process.argv[2]!));
const header = archive.subarray(0, 512);
const text = (start: number, end: number) => new TextDecoder('ascii').decode(header.subarray(start, end));
const octal = (start: number, end: number) => Number.parseInt(text(start, end).replace(/[\0 ]+$/g, ''), 8);
const zeros = (start: number, end: number) => header.subarray(start, end).every((byte) => byte === 0);
const exactOctal = (start: number, end: number, value: number) => {
  const expected = new TextEncoder().encode(`${value.toString(8).padStart(end - start - 1, '0')}\0`);
  return header.subarray(start, end).every((byte, index) => byte === expected[index]);
};
const size = octal(124, 136);
const checksumHeader = header.slice();
checksumHeader.fill(0x20, 148, 156);
const calculatedChecksum = checksumHeader.reduce((total, byte) => total + byte, 0);
const storedChecksum = octal(148, 156);
process.stdout.write(`${JSON.stringify({
  archiveBytes: archive.byteLength,
  path: text(0, 100).replace(/\0+$/g, ''),
  mode: octal(100, 108),
  uid: octal(108, 116),
  gid: octal(116, 124),
  size,
  mtime: octal(136, 148),
  numericCanonical: [
    exactOctal(100, 108, octal(100, 108)),
    exactOctal(108, 116, octal(108, 116)),
    exactOctal(116, 124, octal(116, 124)),
    exactOctal(124, 136, size),
    exactOctal(136, 148, octal(136, 148)),
  ],
  linkZeros: zeros(157, 257),
  magic: Array.from(header.subarray(257, 263)),
  version: Array.from(header.subarray(263, 265)),
  namesZero: zeros(265, 329),
  deviceMajor: text(329, 337).replace(/\0/g, '<NUL>'),
  deviceMinor: text(337, 345).replace(/\0/g, '<NUL>'),
  deviceCanonical: [exactOctal(329, 337, 0), exactOctal(337, 345, 0)],
  suffixZeros: zeros(345, 512),
  storedChecksum,
  calculatedChecksum,
  checksumCanonical: text(148, 156) === `${calculatedChecksum.toString(8).padStart(6, '0')}\0 `,
  expectedBytes: 512 + Math.ceil(size / 512) * 512 + 1_024,
  paddingZeros: archive.subarray(512 + size).every((byte) => byte === 0),
})}\n`);
}

void main();
