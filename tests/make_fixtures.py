#!/usr/bin/env python3
"""Generate the attachment fixtures the e2e suite uploads.

Deterministic, dependency-free (stdlib only). Every text-bearing fixture
carries a unique SENTINEL string so tests can assert the parsed text made
it into the /api/chat payload verbatim.
"""

import os
import struct
import zipfile
import zlib

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)


def write(name, data):
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(os.path.join(OUT, name), mode) as f:
        f.write(data)
    print("wrote", name)


# ---- plain text & markdown -------------------------------------------------

write(
    "sample.txt",
    "Expense notes for the Q3 offsite.\n"
    "The txt sentinel code is TXT-SENTINEL-93417.\n"
    "Total spend was 4 217 EUR across 11 receipts.\n",
)

write(
    "sample.md",
    "# Trip report\n\n"
    "The md sentinel code is **MD-SENTINEL-58221**.\n\n"
    "- day one: travel\n- day two: workshops\n",
)

# A txt bigger than the client's 9 000-char per-doc cap, to exercise
# truncation. The sentinel sits near the START so it survives the cut;
# the tail marker must NOT appear in the payload.
big = (
    "BIGTXT-SENTINEL-77401 begins here.\n"
    + ("filler line to push the document far past the per-doc cap\n" * 400)
    + "TAIL-MARKER-99999 ends here.\n"
)
assert len(big) > 12000
write("big.txt", big)

# An unsupported type for the rejection test.
write("notes.csv", "a,b,c\n1,2,3\n")

# ---- pdf ---------------------------------------------------------------------
# Minimal single-page PDF with an uncompressed text content stream —
# exactly the shape pdf.js extracts text from.

def make_pdf(text_lines):
    content = b"BT /F1 12 Tf 72 720 Td 16 TL\n"
    for line in text_lines:
        esc = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        content += b"(" + esc.encode("latin-1") + b") Tj T*\n"
    content += b"ET\n"

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return out


write(
    "sample.pdf",
    make_pdf(
        [
            "Quarterly infrastructure review",
            "The pdf sentinel code is PDF-SENTINEL-31337.",
            "Uptime held at 99.98 percent across the fleet.",
        ]
    ),
)

# ---- docx --------------------------------------------------------------------
# A .docx is a ZIP whose text lives in word/document.xml. Include tabs,
# breaks, and XML entities to exercise the client's entity unescaping.

DOCX_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body>"
    "<w:p><w:r><w:t>Meeting minutes</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>The docx sentinel code is DOCX-SENTINEL-64502.</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>Budget &amp; scope: &quot;approved&quot; &#8212; final.</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>Col A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col B</w:t></w:r>"
    "<w:r><w:br/></w:r><w:r><w:t>Second line</w:t></w:r></w:p>"
    "</w:body></w:document>"
)

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)

for name, compression in [("sample.docx", zipfile.ZIP_DEFLATED), ("stored.docx", zipfile.ZIP_STORED)]:
    path = os.path.join(OUT, name)
    with zipfile.ZipFile(path, "w", compression) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCX_XML)
    print("wrote", name)

# ---- docx with metadata (author/dates, unaccepted tracked changes, a
# reviewer comment) — exercises the client's metadata-extraction path
# (public/js/docs.js). Deliberately separate from sample.docx/stored.docx
# above so their existing plain-text assertions stay untouched.

METADATA_DOCUMENT_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body>"
    "<w:p><w:r><w:t>Quarterly budget memo.</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>The metadata sentinel is METADOC-SENTINEL-71190.</w:t></w:r>"
    '<w:ins w:id="1" w:author="John Smith" w:date="2024-05-02T10:00:00Z">'
    "<w:r><w:t> INSERTED-SENTINEL-33210 approved for release.</w:t></w:r></w:ins>"
    '<w:del w:id="2" w:author="Jane Doe" w:date="2024-05-01T09:00:00Z">'
    "<w:r><w:delText> Internal figure: DELETED-SENTINEL-88420.</w:delText></w:r></w:del>"
    "</w:p>"
    "</w:body></w:document>"
)

METADATA_COMMENTS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:comment w:id="0" w:author="Jane Doe" w:date="2024-05-01T09:05:00Z">'
    "<w:p><w:r><w:t>COMMENT-SENTINEL-55510 — double check this figure.</w:t></w:r></w:p>"
    "</w:comment>"
    "</w:comments>"
)

METADATA_CORE_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    "<dc:creator>Jane Doe</dc:creator>"
    "<cp:lastModifiedBy>John Smith</cp:lastModifiedBy>"
    '<dcterms:created xsi:type="dcterms:W3CDTF">2024-05-01T09:00:00Z</dcterms:created>'
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-02T10:00:00Z</dcterms:modified>'
    "<cp:revision>3</cp:revision>"
    "<dc:title>Q2 Budget Memo</dc:title>"
    "</cp:coreProperties>"
)

METADATA_APP_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    "<Company>Acme Corp</Company>"
    "<Application>Microsoft Office Word</Application>"
    "</Properties>"
)

METADATA_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/comments.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    '<Override PartName="/docProps/core.xml" '
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    '<Override PartName="/docProps/app.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    "</Types>"
)

METADATA_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '<Relationship Id="rId2" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" '
    'Target="docProps/core.xml"/>'
    '<Relationship Id="rId3" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
    'Target="docProps/app.xml"/>'
    "</Relationships>"
)

with zipfile.ZipFile(os.path.join(OUT, "metadata.docx"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", METADATA_CONTENT_TYPES)
    z.writestr("_rels/.rels", METADATA_RELS)
    z.writestr("word/document.xml", METADATA_DOCUMENT_XML)
    z.writestr("word/comments.xml", METADATA_COMMENTS_XML)
    z.writestr("docProps/core.xml", METADATA_CORE_XML)
    z.writestr("docProps/app.xml", METADATA_APP_XML)
print("wrote metadata.docx")

# ---- images ------------------------------------------------------------------
# Solid-color PNGs. Distinct colors let the vision live-test ask "what
# color is this?" and the report test tell figures apart.

def make_png(rgb, size=256):
    w = h = size
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


write("red.png", make_png((220, 30, 30)))
write("blue.png", make_png((30, 60, 220)))
write("green.png", make_png((30, 180, 60)))
write("yellow.png", make_png((235, 200, 40)))
write("purple.png", make_png((150, 40, 200)))

# A real, renderable JPEG carrying EXIF (camera make/model/software,
# capture time, and GPS coordinates) — exercises public/js/exif.js's
# metadata extraction end-to-end through the real upload/downscale flow.
# Needs Pillow (not stdlib, unlike everything else in this script); skipped
# with a warning if it isn't installed rather than failing the whole run.
try:
    from PIL import Image
    from PIL.TiffImagePlugin import IFDRational

    img = Image.new("RGB", (256, 256), (180, 60, 60))
    exif = img.getexif()
    exif[0x010F] = "Apple"          # Make
    exif[0x0110] = "iPhone 14 Pro"  # Model
    exif[0x0131] = "17.4.1"         # Software
    exif.get_ifd(0x8769)[0x9003] = "2024:05:01 14:32:00"  # DateTimeOriginal
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"                                                    # GPSLatitudeRef
    gps[2] = (IFDRational(40, 1), IFDRational(42, 1), IFDRational(4608, 100))  # 40.7128
    gps[3] = "W"                                                    # GPSLongitudeRef
    gps[4] = (IFDRational(74, 1), IFDRational(0, 1), IFDRational(2160, 100))   # -74.0060
    gps[5] = 0                                                      # GPSAltitudeRef
    gps[6] = IFDRational(10, 1)                                     # GPSAltitude

    path = os.path.join(OUT, "photo.jpg")
    img.save(path, "JPEG", exif=exif)
    print("wrote photo.jpg")
except ImportError:
    print("SKIPPED photo.jpg — Pillow not installed (pip install pillow); "
          "tests/e2e/metadata.spec.js's EXIF cases will fail without it.")

print("fixtures ready in", OUT)
