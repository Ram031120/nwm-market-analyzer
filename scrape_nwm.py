#!/usr/bin/env python3
"""
Mauritius National Wholesale Market (NWM) Incremental PDF Scraper & Database Builder.

Fetches Daily Sales Transaction PDF bulletins from AMB Mauritius
(https://ambmauritius.mu/nwm-publication/), caches PDFs locally in nwm_pdfs_cache/,
stores parsed records in SQLite (data/nwm_history.db) with incremental tracking
via `processed_dates`, and exports data/nwm_data.json and data/nwm_all_vegetables.csv.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import logging
import os
import re
import sqlite3
import sys
import time
import unicodedata
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, unquote

import pdfplumber
import requests
import urllib3
from bs4 import BeautifulSoup

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "nwm_history.db"
JSON_PATH = DATA_DIR / "nwm_data.json"
CSV_PATH = DATA_DIR / "nwm_all_vegetables.csv"
PDF_CACHE_DIR = BASE_DIR / "nwm_pdfs_cache"

AMB_URL = "https://ambmauritius.mu/nwm-publication/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

EXCLUDED_URL_KEYWORDS = (
    "policy",
    "ethics",
    "reform",
    "protocol",
    "conflict",
    "harassment",
    "corruption",
    "tender",
    "vacancy",
    "notice-form",
)

# Particles that should remain lowercase when normalizing item names
LOWERCASE_PARTICLES = {"de", "du", "des", "la", "le", "les", "et", "au", "aux", "en", "a"}

# Exact known canonical overrides for inconsistent AMB PDF spellings/casing
CANONICAL_ITEM_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bpomme\s+d'amour\b", re.IGNORECASE), "Pomme d'Amour"),
    (re.compile(r"\bmelon\s+d'eau\b", re.IGNORECASE), "Melon d'Eau"),
    (re.compile(r"\bcoeur\s+de\s+boeuf\b", re.IGNORECASE), "Coeur de Boeuf"),
    (re.compile(r"\bpomme\s+de\s+terre\b", re.IGNORECASE), "Pomme de Terre"),
    (re.compile(r"\bbrede\s+de\s+chine\b", re.IGNORECASE), "Brede de Chine"),
    (re.compile(r"\bbrede\s+tom\s+pouce\b", re.IGNORECASE), "Brede Tom Pouce"),
    (re.compile(r"\bbrede\s+baton\s+blanc\b", re.IGNORECASE), "Brede Baton Blanc"),
    (re.compile(r"\bbrede\s+baton\s+vert\b", re.IGNORECASE), "Brede Baton Vert"),
    (re.compile(r"\bbrede\s+chouchou\b", re.IGNORECASE), "Brede Chouchou"),
    (re.compile(r"\bbrede\s+giraumon\b", re.IGNORECASE), "Brede Giraumon"),
    (re.compile(r"\bbrede\s+epinard\b", re.IGNORECASE), "Brede Epinard"),
    (re.compile(r"\bbrede\s+malbar\b", re.IGNORECASE), "Brede Malbar"),
    (re.compile(r"\bbrede\s+national\b", re.IGNORECASE), "Brede National"),
    (re.compile(r"\bbrede\s+songe\b", re.IGNORECASE), "Brede Songe"),
    (re.compile(r"\bsans\s+fils?\s*\(\s*haricot\s*\)", re.IGNORECASE), "Sans Fils (Haricot)"),
    (re.compile(r"\bharicot\s*\(\s*sans\s+fils?\s*\)", re.IGNORECASE), "Sans Fils (Haricot)"),
    (re.compile(r"\bchou[\s-]+fleur\b", re.IGNORECASE), "Chou-Fleur"),
    (re.compile(r"\bti[\s-]+piment\b", re.IGNORECASE), "Ti Piment"),
    (re.compile(r"\bti[\s-]+pois\b", re.IGNORECASE), "Ti Pois"),
    (re.compile(r"\bbringelle\s*\(\s*long\s*\)", re.IGNORECASE), "Bringelle (Long)"),
    (re.compile(r"\bbringelle\s*\(\s*rond\s*\)", re.IGNORECASE), "Bringelle (Rond)"),
    (re.compile(r"\bpoivron\s*\(\s*rouge\s*\)", re.IGNORECASE), "Poivron (Rouge)"),
    (re.compile(r"\bpoivron\s*\(\s*vert\s*\)", re.IGNORECASE), "Poivron (Vert)"),
    (re.compile(r"\bpoivron\s*\(\s*jaune\s*\)", re.IGNORECASE), "Poivron (Jaune)"),
    (re.compile(r"\bchou\s*\(\s*vert\s*\)", re.IGNORECASE), "Chou (Vert)"),
    (re.compile(r"\bchou\s*\(\s*mauve\s*\)", re.IGNORECASE), "Chou (Mauve)"),
    (re.compile(r"\(terre\)", re.IGNORECASE), "(Terre)"),
    (re.compile(r"\(serre\)", re.IGNORECASE), "(Serre)"),
    (re.compile(r"\(imp\)", re.IGNORECASE), "(IMP)"),
    (re.compile(r"\(loc\)", re.IGNORECASE), "(LOC)"),
    (re.compile(r"\(loc\s+hy\)", re.IGNORECASE), "(LOC HY)"),
    (re.compile(r"\(loc\s+toupi\)", re.IGNORECASE), "(LOC Toupi)"),
    (re.compile(r"\(local\)", re.IGNORECASE), "(Local)"),
    (re.compile(r"\(jus\)", re.IGNORECASE), "(Jus)"),
    (re.compile(r"\(curry\)", re.IGNORECASE), "(Curry)"),
    (re.compile(r"\(blueberry\)", re.IGNORECASE), "(Blueberry)"),
    # Minor AMB PDF typos
    (re.compile(r"^basilc$", re.IGNORECASE), "Basilic"),
    (re.compile(r"^patate\s+chiniois$", re.IGNORECASE), "Patate Chinois"),
    (re.compile(r"^brede\s+suoflet$", re.IGNORECASE), "Brede Souflet"),
    (re.compile(r"^ananan$", re.IGNORECASE), "Ananas"),
    (re.compile(r"^(?:carossol|carrosol|carousel)$", re.IGNORECASE), "Corossol"),
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("nwm_scraper")


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PDF_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS processed_dates (
            date_iso TEXT PRIMARY KEY,
            date_display TEXT NOT NULL,
            source_urls TEXT NOT NULL,
            record_count INTEGER NOT NULL DEFAULT 0,
            processed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nwm_records (
            date_iso TEXT NOT NULL,
            date TEXT NOT NULL,
            item TEXT NOT NULL,
            unit TEXT,
            qty_sold REAL,
            low_price REAL,
            high_price REAL,
            norm_price REAL,
            PRIMARY KEY (date_iso, item)
        );

        CREATE INDEX IF NOT EXISTS idx_nwm_records_item_date
            ON nwm_records (item, date_iso);
        CREATE INDEX IF NOT EXISTS idx_nwm_records_date
            ON nwm_records (date_iso);
        """
    )
    conn.commit()


def format_date_ddmmyy(d: dt.date) -> str:
    return d.strftime("%d/%m/%y")


def normalize_unit(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = re.sub(r"\s+", " ", str(raw)).strip()
    if not s or s in {"-", "--", "N/A", "n/a", "nil", "NIL"}:
        return None
    low = s.lower().rstrip(".")
    if low in {"kg", "kgs", "kilo", "kilos"}:
        return "Kg"
    if low in {"unit", "units", "u", "un", "pcs", "piece", "pieces"}:
        return "Units"
    if low in {"packet", "packets", "pkt", "pkts", "pk", "pack", "packs"}:
        return "Packet"
    if low in {"box", "boxes", "bx"}:
        return "Box"
    if low in {"lot", "lots"}:
        return "Lot"
    if low in {"crate", "crates"}:
        return "Crate"
    if low in {"pkt/crate", "packet/crate"}:
        return "Pkt/Crate"
    if low in {"bunch", "bunches"}:
        return "Bunch"
    if low in {"bundle", "bundles"}:
        return "Bundle"
    if low in {"bag", "bags"}:
        return "Bag"
    if low in {"tray", "trays"}:
        return "Tray"
    if low in {"1/2 kg", "1/2kg", "unit/1/2kg", "unit / 1/2 kg"}:
        return "Unit/1/2Kg"
    return s.title()


def strip_brede_accent(text: str) -> str:
    # Unify "Brède" / "Brede" so the same item isn't split across two keys
    return re.sub(r"\bBr[èéê]de(s?)\b", r"Brede\1", text, flags=re.IGNORECASE)


def _smart_title_word(word: str, is_first: bool) -> str:
    if not word:
        return word
    # Preserve all-caps acronyms like IMP, LOC, HY
    if word.isupper() and len(word) <= 4 and word.isalpha():
        return word
    low = word.lower()
    if not is_first and low in LOWERCASE_PARTICLES:
        return low
    # Handle apostrophes like d'Amour, l'Oignon
    if "'" in word:
        parts = word.split("'")
        out = []
        for idx, part in enumerate(parts):
            if idx == 0 and len(part) == 1 and part.lower() in {"d", "l"}:
                out.append(part.lower())
            elif part:
                out.append(part[0].upper() + part[1:].lower())
            else:
                out.append("")
        return "'".join(out)
    # Handle hyphenated words like Chou-Fleur
    if "-" in word:
        return "-".join(
            (p[0].upper() + p[1:].lower()) if p else "" for p in word.split("-")
        )
    return word[0].upper() + word[1:].lower()


def normalize_item_name(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = unicodedata.normalize("NFC", str(raw))
    # Unify apostrophes and dashes
    s = s.replace("\u2019", "'").replace("\u2018", "'").replace("`", "'").replace("´", "'")
    s = s.replace("\u2013", "-").replace("\u2014", "-")
    # Remove stray newlines/tabs and collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return None

    # Remove accidental leading serial number e.g. "12 Brede Songe"
    s = re.sub(r"^\d+\s+", "", s).strip()
    # Normalize spacing around parentheses and apostrophes
    s = re.sub(r"\s*\(\s*", " (", s)
    s = re.sub(r"\s*\)\s*", ") ", s)
    s = re.sub(r"\s*'\s*", "'", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Trim stray trailing punctuation
    s = s.strip(" .,:;")
    if not s:
        return None

    # Unify Brède -> Brede
    s = strip_brede_accent(s)

    # Smart title casing outside and inside parentheses
    tokens = re.split(r"(\s+|\(|\))", s)
    normalized_tokens: list[str] = []
    word_idx = 0
    for tok in tokens:
        if not tok or tok.isspace() or tok in {"(", ")"}:
            normalized_tokens.append(tok)
            continue
        normalized_tokens.append(_smart_title_word(tok, is_first=(word_idx == 0)))
        word_idx += 1
    s = "".join(normalized_tokens)
    s = re.sub(r"\s+", " ", s).strip()

    # Apply canonical pattern rules (e.g. Pomme d'Amour (Terre), Poivron (Rouge))
    for pattern, repl in CANONICAL_ITEM_PATTERNS:
        s = pattern.sub(repl, s)

    # Reject obvious header/footer noise, numeric-only artifacts, and summary totals
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return None
    low = s.lower()
    if low in {
        "items",
        "item",
        "vegetables",
        "fruits",
        "items (vegetables)",
        "items (fruits)",
        "sn",
        "s/n",
        "total",
        "grand total",
        "remarks",
        "low price",
        "high price",
        "most common price",
        "units of measure",
        "total qty sold",
    }:
        return None
    if (
        low.startswith("total ")
        or low.startswith("selling price")
        or low.startswith("provisional daily")
        or low.startswith("transaction date")
        or low.startswith("daily sales")
        or low.startswith("national wholesale")
        or low.startswith("date :")
    ):
        return None

    return s


def parse_number(raw: Any) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    s = s.replace(",", "").replace(" ", "")
    if s in {"-", "--", "N/A", "n/a", "nil", "NIL", "*"}:
        return None
    # Strip currency prefix if any
    s = re.sub(r"^(?:Rs\.?|MUR)\s*", "", s, flags=re.IGNORECASE)
    m = re.match(r"^-?\d+(?:\.\d+)?$", s)
    if not m:
        return None
    val = float(s)
    if val < 0:
        return None
    return val


def clean_num_for_export(val: float | None) -> int | float | None:
    if val is None:
        return None
    if float(val).is_integer():
        return int(val)
    return round(float(val), 2)


def extract_date_from_url_or_text(url: str, text: str = "") -> dt.date | None:
    fname = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    for candidate in (fname, text):
        # Match dd.mm.yy, dd.mm.yyyy, dd-mm-yy, dd_mm_yy
        matches = re.findall(r"(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})", candidate)
        for d_s, m_s, y_s in matches:
            d, m, y = int(d_s), int(m_s), int(y_s)
            if y < 100:
                y += 2000
            if 2020 <= y <= 2035 and 1 <= m <= 12 and 1 <= d <= 31:
                try:
                    return dt.date(y, m, d)
                except ValueError:
                    continue
    return None


def fetch_nwm_pdf_links(session: requests.Session) -> dict[str, list[str]]:
    """
    Scrape https://ambmauritius.mu/nwm-publication/ and return a mapping:
    date_iso -> deduplicated list of PDF URLs for that date.
    """
    last_err: Exception | None = None
    html = ""
    for attempt in range(1, 4):
        try:
            resp = session.get(AMB_URL, verify=False, timeout=90)
            resp.raise_for_status()
            html = resp.text
            break
        except Exception as exc:
            last_err = exc
            logger.warning("Fetch index attempt %d failed: %s", attempt, exc)
            time.sleep(2 * attempt)
    else:
        raise RuntimeError(f"Failed to fetch {AMB_URL}: {last_err}")

    soup = BeautifulSoup(html, "html.parser")
    container = soup.find("section", id="content") or soup.find("main") or soup

    date_to_urls: dict[str, list[str]] = {}
    for a in container.find_all("a", href=True):
        href = a["href"].strip()
        if ".pdf" not in href.lower():
            continue
        full_url = urljoin(AMB_URL, href)
        low_url = full_url.lower()
        if any(kw in low_url for kw in EXCLUDED_URL_KEYWORDS):
            continue
        link_text = a.get_text(" ", strip=True)
        parsed_date = extract_date_from_url_or_text(full_url, link_text)
        if not parsed_date:
            continue
        date_iso = parsed_date.isoformat()
        urls = date_to_urls.setdefault(date_iso, [])
        if full_url not in urls:
            urls.append(full_url)

    logger.info("Discovered %d unique NWM trading dates on AMB website.", len(date_to_urls))
    return date_to_urls


def get_cache_path(date_iso: str, url: str) -> Path:
    fname = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", fname).strip("_")
    if not safe_name.lower().endswith(".pdf"):
        safe_name += ".pdf"
    return PDF_CACHE_DIR / f"{date_iso}__{safe_name}"


def download_pdf(
    url: str, date_iso: str, use_cache: bool = True
) -> Path:
    cache_path = get_cache_path(date_iso, url)
    if use_cache and cache_path.exists() and cache_path.stat().st_size > 512:
        with cache_path.open("rb") as f:
            if f.read(4) == b"%PDF":
                return cache_path

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    last_err: Exception | None = None
    for attempt in range(1, 4):
        try:
            resp = session.get(url, verify=False, timeout=90)
            resp.raise_for_status()
            content = resp.content
            if len(content) < 256 or not content.startswith(b"%PDF"):
                raise ValueError(f"Invalid PDF content ({len(content)} bytes) from {url}")
            tmp_path = cache_path.with_suffix(".pdf.tmp")
            tmp_path.write_bytes(content)
            tmp_path.replace(cache_path)
            return cache_path
        except Exception as exc:
            last_err = exc
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"Failed downloading {url}: {last_err}")


def _row_is_header(cells: list[str]) -> bool:
    joined = " ".join(c.lower() for c in cells if c)
    header_markers = (
        "low price",
        "high price",
        "most common",
        "selling price",
        "units of measure",
        "total qty",
        "total quantity",
        "quantity sold",
        "transaction date",
    )
    return any(m in joined for m in header_markers)


def _detect_table_schema(table: list[list[str | None]]) -> str:
    """
    Detect table layout across AMB historical PDF formats:
      - 'std7': [SN, Item, Unit, Total Qty, Low, High, Most Common] (Feb 2024 - present)
      - 'multi_qty': [Item, UnitsQty, KgQty, PktCrateQty, Low, High, Most Common] (Jan 31, 2024)
      - 'price6': [SN, Item, Low, High, Most Common, Remarks] (Jan 20-26, 2024)
    """
    header_text = " ".join(
        str(cell or "").lower()
        for row in table[:4]
        for cell in row
    )
    if "units of" in header_text:
        return "std7"
    if re.search(r"pkt\s*/\s*crate", header_text):
        return "multi_qty"
    if "1/2kg" in header_text or "1/2 kg" in header_text or "remarks" in header_text:
        return "price6"
    max_cols = max((len(r) for r in table), default=0)
    if max_cols == 6 and "quantity" not in header_text:
        return "price6"
    return "std7"


def parse_pdf_file(pdf_path: Path, date_iso: str) -> dict[str, dict[str, Any]]:
    """
    Extract all recorded NWM items from a single PDF.
    Returns dict keyed by normalized item name.
    Zero extrapolation: unrecorded items remain absent; missing fields stay None.
    """
    parsed_date = dt.date.fromisoformat(date_iso)
    date_display = format_date_ddmmyy(parsed_date)
    records: dict[str, dict[str, Any]] = {}

    with pdfplumber.open(pdf_path) as pdf:
        # Check document-level text for legacy 1/2KG or Jan 31 2024 multi-qty format hints
        first_page_text = (pdf.pages[0].extract_text() or "").lower() if pdf.pages else ""
        doc_is_half_kg = (
            ("1/2kg" in first_page_text or "1/2 kg" in first_page_text)
            and "total qty" not in first_page_text
            and "units of" not in first_page_text
        )
        doc_is_multi_qty = (
            "units of" not in first_page_text
            and "quantity sold" in first_page_text
            and bool(re.search(r"pkt\s*/\s*(?:low|high|most|crate)", first_page_text))
            and "crate" in first_page_text[:400]
        )

        for page in pdf.pages:
            tables = page.extract_tables() or []
            for table in tables:
                if not table:
                    continue
                schema = _detect_table_schema(table)
                if doc_is_half_kg and schema == "std7" and max(len(r) for r in table) <= 6:
                    schema = "price6"
                elif doc_is_multi_qty and max(len(r) for r in table) >= 7:
                    schema = "multi_qty"

                for raw_row in table:
                    cells = [re.sub(r"\s+", " ", str(c)).strip() if c is not None else "" for c in raw_row]
                    if not any(cells) or _row_is_header(cells):
                        continue

                    item_raw: str | None = None
                    unit_raw: str | None = None
                    qty_val: float | None = None
                    low_val: float | None = None
                    high_val: float | None = None
                    norm_val: float | None = None

                    if schema == "std7":
                        # Standard 7-column format: [SN, Item, Unit, Qty, Low, High, Norm]
                        if len(cells) >= 7:
                            # Some PDFs occasionally shift SN+Item or include an extra empty col
                            if len(cells) > 7 and not cells[0] and cells[1].isdigit():
                                cells = cells[1:]
                            sn_cell = cells[0]
                            # Validate: either col 0 is SN (digits or empty) and col 1 is Item
                            if sn_cell == "" or re.match(r"^\d+\.?$", sn_cell):
                                item_raw = cells[1]
                                unit_raw = cells[2]
                                qty_val = parse_number(cells[3])
                                low_val = parse_number(cells[4])
                                high_val = parse_number(cells[5])
                                norm_val = parse_number(cells[6])
                            else:
                                # Fallback if SN column was omitted
                                item_raw = cells[0]
                                unit_raw = cells[1]
                                qty_val = parse_number(cells[2])
                                low_val = parse_number(cells[3])
                                high_val = parse_number(cells[4])
                                norm_val = parse_number(cells[5])
                        elif len(cells) == 6:
                            # Missing SN column: [Item, Unit, Qty, Low, High, Norm]
                            item_raw = cells[0]
                            unit_raw = cells[1]
                            qty_val = parse_number(cells[2])
                            low_val = parse_number(cells[3])
                            high_val = parse_number(cells[4])
                            norm_val = parse_number(cells[5])
                        else:
                            continue

                    elif schema == "multi_qty":
                        # Jan 31, 2024: [Item, Units, Kg, Pkt/Crate, Low, High, Norm] (or with leading SN)
                        row_cells = cells[1:] if (len(cells) >= 8 and (cells[0] == "" or cells[0].isdigit())) else cells
                        if len(row_cells) < 7:
                            continue
                        item_raw = row_cells[0]
                        u_qty = parse_number(row_cells[1])
                        kg_qty = parse_number(row_cells[2])
                        pkt_qty = parse_number(row_cells[3])
                        if kg_qty is not None and kg_qty > 0:
                            qty_val, unit_raw = kg_qty, "Kg"
                        elif u_qty is not None and u_qty > 0:
                            qty_val, unit_raw = u_qty, "Units"
                        elif pkt_qty is not None and pkt_qty > 0:
                            qty_val, unit_raw = pkt_qty, "Pkt/Crate"
                        low_val = parse_number(row_cells[4])
                        high_val = parse_number(row_cells[5])
                        norm_val = parse_number(row_cells[6])

                    elif schema == "price6":
                        # Jan 20-26, 2024: [SN, Item, Low, High, Most Common, Remarks]
                        if len(cells) < 5:
                            continue
                        if cells[0] == "" or re.match(r"^\d+\.?$", cells[0]):
                            item_raw = cells[1]
                            low_val = parse_number(cells[2])
                            high_val = parse_number(cells[3])
                            norm_val = parse_number(cells[4])
                        else:
                            item_raw = cells[0]
                            low_val = parse_number(cells[1])
                            high_val = parse_number(cells[2])
                            norm_val = parse_number(cells[3])
                        unit_raw = "Unit/1/2Kg"
                        qty_val = None

                    item = normalize_item_name(item_raw)
                    if not item:
                        continue

                    # Zero extrapolation: skip unrecorded items (no prices AND qty is absent or 0)
                    has_price = any(v is not None for v in (low_val, high_val, norm_val))
                    has_qty = qty_val is not None and qty_val > 0
                    if not has_price and not has_qty:
                        continue
                    # If qty is 0 with no prices, skip; if qty is 0 with prices, keep qty as None/0?
                    # Actually keep literal value if recorded (qty_val as parsed).

                    unit = normalize_unit(unit_raw)
                    rec = {
                        "date_iso": date_iso,
                        "date": date_display,
                        "item": item,
                        "unit": unit,
                        "qty_sold": qty_val,
                        "low_price": low_val,
                        "high_price": high_val,
                        "norm_price": norm_val,
                    }

                    # If the same item appears twice in a PDF (unlikely), keep the richer record
                    existing = records.get(item)
                    if existing is None or (
                        existing["norm_price"] is None and rec["norm_price"] is not None
                    ):
                        records[item] = rec

    return records


def process_single_date(
    date_iso: str, urls: list[str], use_cache: bool = True
) -> tuple[str, list[str], dict[str, dict[str, Any]]]:
    merged: dict[str, dict[str, Any]] = {}
    for url in urls:
        pdf_path = download_pdf(url, date_iso, use_cache=use_cache)
        recs = parse_pdf_file(pdf_path, date_iso)
        for item, rec in recs.items():
            if item not in merged or (
                merged[item]["norm_price"] is None and rec["norm_price"] is not None
            ):
                merged[item] = rec
    return date_iso, urls, merged


def export_json_and_csv(conn: sqlite3.Connection) -> dict[str, Any]:
    """
    Regenerate data/nwm_data.json and data/nwm_all_vegetables.csv from SQLite.
    """
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT date_iso, date, item, unit, qty_sold, low_price, high_price, norm_price
        FROM nwm_records
        ORDER BY date_iso ASC, item ASC
        """
    ).fetchall()

    items_set: set[str] = set()
    years_set: set[int] = set()
    dates_set: set[str] = set()
    records_out: list[dict[str, Any]] = []

    for date_iso, date_disp, item, unit, qty_sold, low_p, high_p, norm_p in rows:
        items_set.add(item)
        years_set.add(int(date_iso[:4]))
        dates_set.add(date_iso)
        records_out.append(
            {
                "date_iso": date_iso,
                "date": date_disp,
                "item": item,
                "unit": unit,
                "qty_sold": clean_num_for_export(qty_sold),
                "low_price": clean_num_for_export(low_p),
                "high_price": clean_num_for_export(high_p),
                "norm_price": clean_num_for_export(norm_p),
            }
        )

    sorted_items = sorted(items_set, key=lambda s: s.lower())
    sorted_years = sorted(years_set)
    sorted_dates = sorted(dates_set)

    if sorted_dates:
        min_iso = sorted_dates[0]
        max_iso = sorted_dates[-1]
        min_disp = format_date_ddmmyy(dt.date.fromisoformat(min_iso))
        max_disp = format_date_ddmmyy(dt.date.fromisoformat(max_iso))
    else:
        min_iso = max_iso = min_disp = max_disp = None

    last_updated_disp = max_disp or format_date_ddmmyy(dt.date.today())

    payload = {
        "last_updated": last_updated_disp,
        "last_updated_iso": max_iso,
        "synced_at": format_date_ddmmyy(dt.date.today()),
        "total_trading_days": len(sorted_dates),
        "total_records": len(records_out),
        "date_range": {
            "min_iso": min_iso,
            "max_iso": max_iso,
            "min": min_disp,
            "max": max_disp,
        },
        "items": sorted_items,
        "years": sorted_years,
        "records": records_out,
    }

    tmp_json = JSON_PATH.with_suffix(".json.tmp")
    with tmp_json.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    tmp_json.replace(JSON_PATH)

    tmp_csv = CSV_PATH.with_suffix(".csv.tmp")
    with tmp_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            ["date_iso", "date", "item", "unit", "qty_sold", "low_price", "high_price", "norm_price"]
        )
        for r in records_out:
            writer.writerow(
                [
                    r["date_iso"],
                    r["date"],
                    r["item"],
                    r["unit"] if r["unit"] is not None else "",
                    r["qty_sold"] if r["qty_sold"] is not None else "",
                    r["low_price"] if r["low_price"] is not None else "",
                    r["high_price"] if r["high_price"] is not None else "",
                    r["norm_price"] if r["norm_price"] is not None else "",
                ]
            )
    tmp_csv.replace(CSV_PATH)

    logger.info(
        "Exported %d records (%d items, %d trading days, years=%s) -> %s & %s",
        len(records_out),
        len(sorted_items),
        len(sorted_dates),
        sorted_years,
        JSON_PATH.name,
        CSV_PATH.name,
    )
    return {
        "last_updated": last_updated_disp,
        "last_updated_iso": max_iso,
        "total_trading_days": len(sorted_dates),
        "total_items": len(sorted_items),
        "total_records": len(records_out),
        "years": sorted_years,
    }


def sync_nwm_data(
    rebuild: bool = False,
    use_cache: bool = True,
    max_workers: int = 8,
    limit: int | None = None,
) -> dict[str, Any]:
    """
    Run an incremental (or full --rebuild) NWM sync.
    Returns a summary dict suitable for CLI output or /api/sync JSON response.
    """
    t0 = time.monotonic()
    ensure_dirs()

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    try:
        if rebuild:
            logger.info("--rebuild requested: clearing nwm_records and processed_dates.")
            conn.execute("DELETE FROM nwm_records")
            conn.execute("DELETE FROM processed_dates")
            conn.commit()

        existing_dates = {
            row[0] for row in conn.execute("SELECT date_iso FROM processed_dates").fetchall()
        }

        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT})
        all_date_urls = fetch_nwm_pdf_links(session)

        # Only fetch dates not already in processed_dates (newest first)
        pending_dates = sorted((d for d in all_date_urls if d not in existing_dates), reverse=True)
        if limit is not None and limit > 0:
            pending_dates = pending_dates[:limit]

        logger.info(
            "Already in SQLite: %d dates | New dates to fetch: %d",
            len(existing_dates),
            len(pending_dates),
        )

        new_dates_added = 0
        new_records_added = 0
        failed_dates: list[dict[str, str]] = []

        if pending_dates:
            now_iso = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            completed = 0
            total_pending = len(pending_dates)

            pool_cls = (
                ProcessPoolExecutor
                if (rebuild or total_pending > 12)
                else ThreadPoolExecutor
            )
            worker_count = min(max_workers, os.cpu_count() or 4) if pool_cls is ProcessPoolExecutor else max_workers
            with pool_cls(max_workers=worker_count) as pool:
                futures = {
                    pool.submit(
                        process_single_date, d_iso, all_date_urls[d_iso], use_cache
                    ): d_iso
                    for d_iso in pending_dates
                }

                for fut in as_completed(futures):
                    d_iso = futures[fut]
                    completed += 1
                    try:
                        date_iso, urls, recs = fut.result()
                        date_disp = format_date_ddmmyy(dt.date.fromisoformat(date_iso))
                        with conn:
                            conn.executemany(
                                """
                                INSERT OR REPLACE INTO nwm_records
                                    (date_iso, date, item, unit, qty_sold, low_price, high_price, norm_price)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                """,
                                [
                                    (
                                        r["date_iso"],
                                        r["date"],
                                        r["item"],
                                        r["unit"],
                                        r["qty_sold"],
                                        r["low_price"],
                                        r["high_price"],
                                        r["norm_price"],
                                    )
                                    for r in recs.values()
                                ],
                            )
                            conn.execute(
                                """
                                INSERT OR REPLACE INTO processed_dates
                                    (date_iso, date_display, source_urls, record_count, processed_at)
                                VALUES (?, ?, ?, ?, ?)
                                """,
                                (date_iso, date_disp, json.dumps(urls), len(recs), now_iso),
                            )
                        new_dates_added += 1
                        new_records_added += len(recs)
                        if completed % 25 == 0 or completed == total_pending:
                            logger.info(
                                "Progress: %d/%d dates processed (+%d records)",
                                completed,
                                total_pending,
                                new_records_added,
                            )
                    except Exception as exc:
                        logger.error("Failed date %s: %s", d_iso, exc)
                        failed_dates.append({"date_iso": d_iso, "error": str(exc)})

        # Regenerate JSON & CSV if new dates were added, rebuild ran, or files don't exist
        needs_export = (
            new_dates_added > 0
            or rebuild
            or not JSON_PATH.exists()
            or not CSV_PATH.exists()
        )
        if needs_export:
            export_stats = export_json_and_csv(conn)
        else:
            row = conn.execute(
                """
                SELECT
                    COUNT(DISTINCT date_iso),
                    COUNT(DISTINCT item),
                    COUNT(*),
                    MAX(date_iso)
                FROM nwm_records
                """
            ).fetchone()
            max_iso = row[3]
            export_stats = {
                "last_updated": format_date_ddmmyy(dt.date.fromisoformat(max_iso)) if max_iso else None,
                "last_updated_iso": max_iso,
                "total_trading_days": row[0],
                "total_items": row[1],
                "total_records": row[2],
                "years": [
                    int(r[0])
                    for r in conn.execute(
                        "SELECT DISTINCT substr(date_iso, 1, 4) FROM nwm_records ORDER BY 1"
                    ).fetchall()
                ],
            }

        elapsed = round(time.monotonic() - t0, 2)
        summary = {
            "status": "ok",
            "rebuild": rebuild,
            "discovered_dates": len(all_date_urls),
            "skipped_dates": len(existing_dates) if not rebuild else 0,
            "new_dates_added": new_dates_added,
            "new_records_added": new_records_added,
            "failed_dates": failed_dates,
            "duration_seconds": elapsed,
            **export_stats,
        }
        return summary
    finally:
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
        conn.close()


def get_db_status() -> dict[str, Any]:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    try:
        row = conn.execute(
            """
            SELECT
                COUNT(DISTINCT date_iso),
                COUNT(DISTINCT item),
                COUNT(*),
                MIN(date_iso),
                MAX(date_iso)
            FROM nwm_records
            """
        ).fetchone()
        processed_count = conn.execute("SELECT COUNT(*) FROM processed_dates").fetchone()[0]
        max_iso = row[4]
        min_iso = row[3]
        return {
            "status": "ok",
            "processed_dates": processed_count,
            "total_trading_days": row[0],
            "total_items": row[1],
            "total_records": row[2],
            "min_date": format_date_ddmmyy(dt.date.fromisoformat(min_iso)) if min_iso else None,
            "last_updated": format_date_ddmmyy(dt.date.fromisoformat(max_iso)) if max_iso else None,
            "json_exists": JSON_PATH.exists(),
            "csv_exists": CSV_PATH.exists(),
        }
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Incremental Mauritius NWM Daily Sales PDF Scraper"
    )
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Clear SQLite tables and re-parse all bulletins (reusing cached PDFs unless --no-cache).",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Force re-downloading PDFs instead of reading from nwm_pdfs_cache/.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Concurrent download/parse workers (default: 8).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional limit on number of most-recent pending dates to process.",
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="Regenerate data/nwm_data.json and data/nwm_all_vegetables.csv from existing SQLite DB.",
    )
    args = parser.parse_args()

    if args.export_only:
        ensure_dirs()
        conn = sqlite3.connect(DB_PATH)
        init_db(conn)
        try:
            res = export_json_and_csv(conn)
            print(json.dumps(res, indent=2))
            return 0
        finally:
            conn.close()

    res = sync_nwm_data(
        rebuild=args.rebuild,
        use_cache=not args.no_cache,
        max_workers=args.workers,
        limit=args.limit,
    )
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
