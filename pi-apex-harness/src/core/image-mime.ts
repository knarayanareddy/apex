/** Buffer-based equivalent of pi-coding-agent 1.4.0's MIT-licensed image sniffer.
 * The caller supplies bytes read through the confined reader, never an unchecked path.
 */
export function detectSupportedImageMimeType(buffer: Buffer): string | null {
  const starts = (offset: number, value: string) => buffer.subarray(offset, offset + value.length).equals(Buffer.from(value, "ascii"));
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (buffer.length >= 16 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buffer.readUInt32BE(8) !== 13 || !starts(12, "IHDR")) return null;
    for (let offset = 8; offset + 8 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (starts(offset + 4, "acTL")) return null;
      if (starts(offset + 4, "IDAT")) return "image/png";
      const next = offset + 12 + length;
      if (next <= offset || next > buffer.length) break;
      offset = next;
    }
    return "image/png";
  }
  if (starts(0, "GIF87a") || starts(0, "GIF89a")) return "image/gif";
  if (starts(0, "RIFF") && starts(8, "WEBP")) return "image/webp";
  if (starts(0, "BM") && buffer.length >= 26) {
    const size = buffer.readUInt32LE(2), pixelOffset = buffer.readUInt32LE(10), dibSize = buffer.readUInt32LE(14);
    if ((size !== 0 && size < 26) || pixelOffset < 14 + dibSize || (size !== 0 && pixelOffset >= size)) return null;
    if (dibSize === 12) {
      return buffer.readUInt16LE(22) === 1 && [1, 4, 8, 16, 24, 32].includes(buffer.readUInt16LE(24)) ? "image/bmp" : null;
    }
    if (dibSize >= 40 && dibSize <= 124 && buffer.length >= 30) {
      return buffer.readUInt16LE(26) === 1 && [1, 4, 8, 16, 24, 32].includes(buffer.readUInt16LE(28)) ? "image/bmp" : null;
    }
  }
  return null;
}
