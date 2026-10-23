// Validate the container before accepting a file as MP4; names/MIME types are untrusted.
export function isMp4(bytes: Buffer): boolean {
  let offset = 0;
  let hasFileType = false;
  let hasMovie = false;
  let hasMedia = false;
  const brands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "]);
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) return false;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) return false;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(bytes.length - offset)) return false;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || size > bytes.length - offset) return false;
    const start = offset + headerSize;
    const end = offset + size;
    if (type === "ftyp") {
      if (hasFileType || size < headerSize + 8 || (size - headerSize) % 4 !== 0) return false;
      hasFileType = brands.has(bytes.toString("ascii", start, start + 4));
      for (let brand = start + 8; brand < end; brand += 4) {
        hasFileType ||= brands.has(bytes.toString("ascii", brand, brand + 4));
      }
      if (!hasFileType) return false;
    }
    // Require movie metadata and payload; an ftyp header alone is not a video.
    if (type === "moov" && size > headerSize) hasMovie = true;
    if (type === "mdat" && size > headerSize) hasMedia = true;
    offset = end;
  }
  return hasFileType && hasMovie && hasMedia;
}
