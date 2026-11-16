//! Bounded raster-header validation, not a full image decoder.
const MAX_SIDE: u32 = 4096;
const MAX_PIXELS: u64 = 16_000_000;

type Dimensions = (u32, u32);
type HeaderResult = Result<Dimensions, &'static str>;

pub(super) fn dimensions(extension: &str, bytes: &[u8]) -> HeaderResult {
    let size = match extension {
        "png" => png(bytes),
        "jpg" | "jpeg" => jpeg(bytes),
        "webp" => webp(bytes),
        _ => Err("distributed textures must be PNG, JPEG or WebP"),
    }?;
    if size.0 == 0
        || size.1 == 0
        || size.0 > MAX_SIDE
        || size.1 > MAX_SIDE
        || u64::from(size.0) * u64::from(size.1) > MAX_PIXELS
    {
        return Err("texture dimensions must be 1–4096 per side and at most 16 megapixels");
    }
    Ok(size)
}

fn png(bytes: &[u8]) -> HeaderResult {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("invalid PNG signature");
    }
    let mut position = 8;
    let mut size = None;
    let mut data = false;
    while position < bytes.len() {
        let header = bytes
            .get(position..position + 8)
            .ok_or("truncated PNG chunk")?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = position
            .checked_add(12)
            .and_then(|value| value.checked_add(length))
            .ok_or("invalid PNG length")?;
        let payload = bytes
            .get(position + 8..end - 4)
            .ok_or("truncated PNG payload")?;
        bytes.get(end - 4..end).ok_or("truncated PNG CRC")?;
        match &header[4..8] {
            b"IHDR" if position == 8 && length == 13 => {
                let width = u32::from_be_bytes(payload[..4].try_into().unwrap());
                let height = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                let valid_depth = match payload[9] {
                    0 => matches!(payload[8], 1 | 2 | 4 | 8 | 16),
                    2 | 4 | 6 => matches!(payload[8], 8 | 16),
                    3 => matches!(payload[8], 1 | 2 | 4 | 8),
                    _ => false,
                };
                if !valid_depth || payload[10] != 0 || payload[11] != 0 || payload[12] > 1 {
                    return Err("invalid PNG IHDR encoding");
                }
                size = Some((width, height));
            }
            b"IHDR" => return Err("invalid or duplicate PNG IHDR"),
            b"acTL" => return Err("animated distributed textures are not supported"),
            b"IDAT" if size.is_some() => data = true,
            b"IEND" if length == 0 && data && end == bytes.len() => {
                return size.ok_or("missing PNG IHDR")
            }
            b"IEND" => return Err("invalid PNG end chunk"),
            _ if size.is_none() => return Err("PNG must begin with IHDR"),
            _ => {}
        }
        position = end;
    }
    Err("PNG is missing image data or IEND")
}

fn jpeg(bytes: &[u8]) -> HeaderResult {
    if !bytes.starts_with(b"\xff\xd8") || !bytes.ends_with(b"\xff\xd9") {
        return Err("invalid or truncated JPEG");
    }
    let mut position = 2;
    while position < bytes.len() - 2 {
        if bytes[position] != 0xff {
            return Err("invalid JPEG marker");
        }
        while bytes.get(position) == Some(&0xff) {
            position += 1;
        }
        let marker = *bytes.get(position).ok_or("truncated JPEG marker")?;
        position += 1;
        if marker == 0xda || marker == 0xd9 {
            return Err("JPEG scan precedes dimensions");
        }
        let length = bytes
            .get(position..position + 2)
            .ok_or("truncated JPEG segment")?;
        let length = u16::from_be_bytes(length.try_into().unwrap()) as usize;
        if length < 2 {
            return Err("invalid JPEG segment length");
        }
        let payload = bytes
            .get(position + 2..position + length)
            .ok_or("truncated JPEG segment")?;
        if matches!(marker, 0xc0..=0xc2) {
            if payload.len() < 6
                || payload[0] != 8
                || !(1..=4).contains(&payload[5])
                || length != 8 + 3 * usize::from(payload[5])
            {
                return Err("invalid JPEG SOF");
            }
            let height = u16::from_be_bytes(payload[1..3].try_into().unwrap()) as u32;
            let width = u16::from_be_bytes(payload[3..5].try_into().unwrap()) as u32;
            return Ok((width, height));
        }
        position += length;
    }
    Err("JPEG is missing a supported SOF header")
}

fn webp(bytes: &[u8]) -> HeaderResult {
    if !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") {
        return Err("invalid WebP signature");
    }
    let declared = bytes.get(4..8).ok_or("truncated WebP RIFF")?;
    if u32::from_le_bytes(declared.try_into().unwrap()) as usize + 8 != bytes.len() {
        return Err("inconsistent WebP RIFF length");
    }
    let mut position = 12;
    let mut canvas = None;
    let mut image = None;
    while position < bytes.len() {
        let header = bytes
            .get(position..position + 8)
            .ok_or("truncated WebP chunk")?;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let payload = bytes
            .get(position + 8..position + 8 + length)
            .ok_or("truncated WebP payload")?;
        match &header[..4] {
            b"VP8X" if position == 12 && length == 10 => {
                if payload[0] & 0xc3 != 0 || payload[1..4] != [0; 3] {
                    return Err("invalid or animated WebP canvas");
                }
                canvas = Some((u24(&payload[4..7]) + 1, u24(&payload[7..10]) + 1));
            }
            b"VP8X" => return Err("invalid WebP extended header"),
            b"VP8 " | b"VP8L" if image.is_none() => {
                image = Some(webp_frame(&header[..4], payload)?)
            }
            b"VP8 " | b"VP8L" | b"ANIM" | b"ANMF" => {
                return Err("duplicate or animated WebP image")
            }
            _ => {}
        }
        position += 8 + length + (length % 2);
    }
    if position != bytes.len() {
        return Err("missing WebP chunk padding");
    }
    let image = image.ok_or("WebP is missing raster data")?;
    if canvas.is_some_and(|canvas| canvas != image) {
        return Err("WebP canvas and raster dimensions disagree");
    }
    Ok(image)
}

fn webp_frame(kind: &[u8], payload: &[u8]) -> HeaderResult {
    if kind == b"VP8L" {
        if payload.len() < 5 || payload[0] != 0x2f {
            return Err("invalid WebP lossless header");
        }
        let bits = u32::from_le_bytes(payload[1..5].try_into().unwrap());
        if bits >> 29 != 0 {
            return Err("unsupported WebP lossless version");
        }
        return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
    }
    if payload.len() < 10 || payload[0] & 1 != 0 || payload[3..6] != [0x9d, 0x01, 0x2a] {
        return Err("invalid WebP lossy frame header");
    }
    Ok((
        (u16::from_le_bytes(payload[6..8].try_into().unwrap()) & 0x3fff) as u32,
        (u16::from_le_bytes(payload[8..10].try_into().unwrap()) & 0x3fff) as u32,
    ))
}

fn u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | u32::from(bytes[1]) << 8 | u32::from(bytes[2]) << 16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = width.to_be_bytes().to_vec();
        ihdr.extend(height.to_be_bytes());
        ihdr.extend([8, 2, 0, 0, 0]);
        for (name, data) in [
            (b"IHDR", ihdr.as_slice()),
            (b"IDAT", &[0][..]),
            (b"IEND", &[][..]),
        ] {
            bytes.extend((data.len() as u32).to_be_bytes());
            bytes.extend(name);
            bytes.extend(data);
            bytes.extend([0; 4]);
        }
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 11, 8];
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([1, 1, 0x11, 0, 0xff, 0xd9]);
        bytes
    }

    fn webp(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        body.extend(kind);
        body.extend((payload.len() as u32).to_le_bytes());
        body.extend(payload);
        if payload.len() % 2 == 1 {
            body.push(0);
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((body.len() as u32).to_le_bytes());
        bytes.extend(body);
        bytes
    }

    #[test]
    fn dimensions_reject_pixel_bombs_and_truncated_raster_headers() {
        for (extension, mut bytes) in [
            ("png", png(4, 5)),
            ("jpg", jpeg(4, 5)),
            ("webp", webp(b"VP8L", &[0x2f, 3, 0, 1, 0])),
        ] {
            assert_eq!(dimensions(extension, &bytes).unwrap(), (4, 5));
            bytes.pop();
            assert!(dimensions(extension, &bytes).is_err());
        }
        assert!(dimensions("png", &png(4097, 1)).is_err());
        assert!(dimensions("png", &png(4096, 4096)).is_err());
        assert!(dimensions("jpg", &jpeg(1, 4097)).is_err());
        assert!(dimensions("png", &png(0, 1)).is_err());
        let bits = (4097_u32 - 1).to_le_bytes();
        let mut payload = vec![0x2f];
        payload.extend(bits);
        assert!(dimensions("webp", &webp(b"VP8L", &payload)).is_err());
        assert!(dimensions("png", b"\x89PNG\r\n\x1a\n").is_err());
        assert!(dimensions("jpg", b"\xff\xd8\xff\xd9").is_err());
    }

    #[test]
    fn webp_supports_lossy_and_extended_headers_and_rejects_inconsistent_canvas() {
        let lossy = [0, 0, 0, 0x9d, 1, 0x2a, 4, 0, 5, 0];
        assert_eq!(dimensions("webp", &webp(b"VP8 ", &lossy)).unwrap(), (4, 5));
        let mut extended = webp(b"VP8X", &[0, 0, 0, 0, 3, 0, 0, 4, 0, 0]);
        let lossless = webp(b"VP8L", &[0x2f, 3, 0, 1, 0]);
        extended.extend(&lossless[12..]);
        let length = (extended.len() as u32 - 8).to_le_bytes();
        extended[4..8].copy_from_slice(&length);
        assert_eq!(dimensions("webp", &extended).unwrap(), (4, 5));
        extended[24] = 7;
        assert!(dimensions("webp", &extended).is_err());
        extended[20] = 2;
        assert!(dimensions("webp", &extended).is_err());
    }
}
