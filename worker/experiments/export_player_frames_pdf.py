"""Print the existing local frame-reference report without another model request."""
import argparse
import shutil
import subprocess
from pathlib import Path


PRINT_STYLE = """<style>
@page {size:A4 landscape; margin:12mm}
@media print {
  body {background:white!important;color:#111!important;max-width:none;margin:0;padding:0;font-size:10pt}
  a {color:#163d62!important}
  .notice {background:#f0f3ed!important}
  table {font-size:8pt!important;table-layout:fixed}
  th,td {overflow-wrap:anywhere;padding:6px!important}
  thead {display:table-header-group}
  tr {break-inside:avoid}
  div {overflow:visible!important}
  figure {break-inside:avoid;margin:12px 0;page-break-before:always}
  img {display:block;max-height:150mm;object-fit:contain}
  figcaption {font-size:9pt}
}
</style>"""


def export(root):
    chromium = shutil.which("chromium")
    if not chromium:
        raise RuntimeError("Chromium is required to print this report")
    source = root / "clearest-player-frames.html"
    printable = root / "clearest-player-frames-print.html"
    content = source.read_text().replace('loading="lazy"', "")
    printable.write_text(content.replace("</html>", PRINT_STYLE + "</html>"))
    output = (root / "clearest-player-frames.pdf").resolve()
    subprocess.run([
        chromium, "--headless", "--no-sandbox", "--disable-gpu",
        "--no-pdf-header-footer", "--allow-file-access-from-files",
        f"--print-to-pdf={output}", printable.resolve().as_uri(),
    ], check=True, timeout=90, capture_output=True)
    if not output.exists() or output.stat().st_size < 10000:
        raise RuntimeError("PDF export did not produce a valid-sized file")
    if output.read_bytes()[:5] != b"%PDF-":
        raise RuntimeError("Unexpected output format")
    print(f"PDF created: {output} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    export(parser.parse_args().input)
