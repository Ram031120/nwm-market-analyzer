// Mauritius NWM Vegetable & Fruit Analysis Dashboard
// Location-agnostic calendar date arithmetic powered by Temporal.PlainDate
// (with conditional temporal-polyfill fallback for browsers without native Temporal).

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const YEAR_PALETTE = [
  "#059669", // emerald
  "#0284c7", // sky
  "#d97706", // amber
  "#7c3aed", // violet
  "#db2777", // pink
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#ea580c", // orange
];

const QUICK_PIN_DEFAULTS = [
  "Pomme d'Amour (Serre)",
  "Pomme d'Amour (Terre)",
  "Poivron (Rouge)",
  "Poivron (Vert)",
];

const LAST_SEEN_DATE_KEY = "nwm_last_seen_max_iso";

const state = {
  rawData: null,
  recordsByItem: new Map(),
  recordsByDate: new Map(),
  recordsByYearMonth: new Map(),
  sortedTradingDates: [],
  sortedYearMonths: [],
  itemLatestUnit: new Map(),
  selectedItem: "",
  compareItemA: "",
  compareItemB: "",
  compareACustom: false,
  priceUnit: "lb", // "lb" | "kg" (default Rs/lb)
  fromIso: "",
  toIso: "",
  activePreset: "30d", // "14d" | "30d" | "90d" | "ytd" | "all" | "custom"
  d2dMode: "date", // "date" | "month"
  d2dDateA: "",
  d2dDateB: "",
  d2dMonthA: "",
  d2dMonthB: "",
  d2dSearch: "",
  d2dSort: "alpha",
  d2dBothOnly: false,
  selectedYears: new Set(),
  primaryGrouping: "day", // "day" | "month"
  compareGrouping: "day", // "day" | "month"
  tomatoGrouping: "day", // "day" | "month"
  tomatoVolMode: "kg", // "kg" | "pct"
  monthlyMetric: "price", // "price" | "qty"
  monthlyMatchMonths: true,
  activeAppTab: "dashboard", // "dashboard" | "movers"
  moversCategory: "all", // "all" (separated) | "vegetable" | "fruit"
  moversTimeframe: "1D", // "1D" | "14D" | "30D" | "90D"
  moversFilter: "all", // "all" | "gainers" | "losers" | "unchanged"
  moversSearch: "",
  moversSort: "gain-desc", // "gain-desc" | "drop-asc" | "price-desc" | "alpha"
  moversBadgeMode: "pct", // "pct" | "abs"
  charts: {
    dailyPrice: null,
    dailyVolume: null,
    tomatoVolume: null,
    tomatoPrice: null,
    d2dPrice: null,
    d2dVolume: null,
    monthly: null,
    comparePrice: null,
    compareVolume: null,
  },
  comboboxes: {},
};

// ---------------------------------------------------------------------------
// Temporal PlainDate helpers (zero timezone drift, strict dd/mm/yy display)
// ---------------------------------------------------------------------------

async function ensureTemporal() {
  if (typeof globalThis.Temporal === "undefined") {
    const mod = await import("https://esm.sh/temporal-polyfill@0.3.0");
    globalThis.Temporal = mod.Temporal;
  }
}

function toPlainDate(iso) {
  return Temporal.PlainDate.from(iso);
}

function formatPlainDateDDMMYY(pd) {
  const dd = String(pd.day).padStart(2, "0");
  const mm = String(pd.month).padStart(2, "0");
  const yy = String(pd.year % 100).padStart(2, "0");
  return `${dd}/${mm}/${yy}`;
}

function formatIsoDDMMYY(iso) {
  if (!iso) return "--/--/--";
  return formatPlainDateDDMMYY(toPlainDate(iso));
}

function parseDDMMYYToIso(input) {
  const cleaned = String(input || "").trim();
  const match = cleaned.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (match[3].length === 2) {
    year += year >= 70 ? 1900 : 2000;
  }
  try {
    const pd = Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
    return pd.toString();
  } catch {
    return null;
  }
}

function subtractDaysIso(iso, days) {
  return toPlainDate(iso).subtract({ days }).toString();
}

function subtractYearsIso(iso, years) {
  return toPlainDate(iso).subtract({ years }).toString();
}

function getWeekdayShort(iso) {
  if (!iso) return "";
  return WEEKDAY_NAMES[toPlainDate(iso).dayOfWeek - 1] || "";
}

function formatIsoWithWeekday(iso) {
  if (!iso) return "--/--/--";
  return `${formatIsoDDMMYY(iso)} (${getWeekdayShort(iso)})`;
}

function formatYearMonthShort(ym) {
  if (!ym) return "--/--";
  const [yStr, mStr] = ym.split("-");
  return `${MONTH_NAMES[Number(mStr) - 1]} ${yStr.slice(-2)}`;
}

function formatYearMonthLong(ym) {
  if (!ym) return "--";
  const [yStr, mStr] = ym.split("-");
  return `${MONTH_NAMES[Number(mStr) - 1]} ${yStr}`;
}

function subtractYearMonth(ym, duration) {
  if (!ym) return "";
  return Temporal.PlainYearMonth.from(ym).subtract(duration).toString();
}

function daysBetweenIso(startIso, endIso) {
  const a = toPlainDate(startIso);
  const b = toPlainDate(endIso);
  return a.until(b, { largestUnit: "day" }).days;
}

function clampIso(iso, minIso, maxIso) {
  if (minIso && iso < minIso) return minIso;
  if (maxIso && iso > maxIso) return maxIso;
  return iso;
}

// ---------------------------------------------------------------------------
// Formatting & Unit Conversion Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSearchKey(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isKgUnit(unit) {
  return typeof unit === "string" && unit.trim().toLowerCase() === "kg";
}

function convertPrice(rawPrice, recordUnit) {
  if (rawPrice === null || rawPrice === undefined || Number.isNaN(Number(rawPrice))) {
    return null;
  }
  const num = Number(rawPrice);
  if (state.priceUnit === "lb" && isKgUnit(recordUnit)) {
    return num / 2;
  }
  return num;
}

function getPriceUnitLabel(itemUnit) {
  if (isKgUnit(itemUnit)) {
    return state.priceUnit === "lb" ? "Rs/lb" : "Rs/kg";
  }
  if (!itemUnit) return "Rs/unit";
  return `Rs/${itemUnit}`;
}

function formatPrice(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return Number.isInteger(val)
    ? val.toLocaleString("en-US")
    : val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQty(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return Math.round(val).toLocaleString("en-US");
}

function formatSignedPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Data Indexing & Supply Drop Analytics
// ---------------------------------------------------------------------------

function indexDataset(data) {
  state.rawData = data;
  state.recordsByItem = new Map();
  state.recordsByDate = new Map();
  state.recordsByYearMonth = new Map();
  state.itemLatestUnit = new Map();

  for (const rec of data.records) {
    let list = state.recordsByItem.get(rec.item);
    if (!list) {
      list = [];
      state.recordsByItem.set(rec.item, list);
    }
    list.push(rec);

    let dateMap = state.recordsByDate.get(rec.date_iso);
    if (!dateMap) {
      dateMap = new Map();
      state.recordsByDate.set(rec.date_iso, dateMap);
    }
    dateMap.set(rec.item, rec);

    const ym = rec.date_iso.slice(0, 7);
    let ymMap = state.recordsByYearMonth.get(ym);
    if (!ymMap) {
      ymMap = new Map();
      state.recordsByYearMonth.set(ym, ymMap);
    }
    let ymItemList = ymMap.get(rec.item);
    if (!ymItemList) {
      ymItemList = [];
      ymMap.set(rec.item, ymItemList);
    }
    ymItemList.push(rec);

    if (rec.unit) {
      state.itemLatestUnit.set(rec.item, rec.unit);
    }
  }
  state.sortedTradingDates = [...state.recordsByDate.keys()].sort();
  state.sortedYearMonths = [...state.recordsByYearMonth.keys()].sort();

  // Records are sorted by date_iso ASC from Python export; precompute trailing 7-day avg volume
  // using up to the prior 7 recorded trading days within 30 calendar days (no extrapolation).
  for (const [, list] of state.recordsByItem.entries()) {
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      if (cur.qty_sold === null || cur.qty_sold === undefined) {
        cur._avg7Qty = null;
        cur._dropPct = null;
        cur._isSupplyDrop = false;
        continue;
      }
      const priorQtys = [];
      for (let j = i - 1; j >= 0 && priorQtys.length < 7; j--) {
        const prev = list[j];
        if (daysBetweenIso(prev.date_iso, cur.date_iso) > 30) break;
        if (prev.qty_sold !== null && prev.qty_sold !== undefined && prev.qty_sold > 0) {
          priorQtys.push(prev.qty_sold);
        }
      }
      if (priorQtys.length >= 2) {
        const avg7 = priorQtys.reduce((a, b) => a + b, 0) / priorQtys.length;
        const pctDiff = ((cur.qty_sold - avg7) / avg7) * 100;
        cur._avg7Qty = avg7;
        cur._avg7Count = priorQtys.length;
        cur._dropPct = pctDiff;
        cur._isSupplyDrop = pctDiff < -30;
      } else {
        cur._avg7Qty = null;
        cur._avg7Count = 0;
        cur._dropPct = null;
        cur._isSupplyDrop = false;
      }
    }
  }
}

function getItemRecordsInRange(itemName, fromIso = state.fromIso, toIso = state.toIso) {
  const all = state.recordsByItem.get(itemName) || [];
  return all.filter((r) => r.date_iso >= fromIso && r.date_iso <= toIso);
}

function resolveBestItemMatch(target, items) {
  if (!items.length) return "";
  if (items.includes(target)) return target;
  const targetKey = normalizeSearchKey(target);
  const exact = items.find((i) => normalizeSearchKey(i) === targetKey);
  if (exact) return exact;
  const partial = items.find((i) => normalizeSearchKey(i).includes(targetKey));
  return partial || "";
}

// ---------------------------------------------------------------------------
// Reusable Accessible Searchable Combobox
// ---------------------------------------------------------------------------

function createCombobox({ containerId, inputId, listboxId, onSelect }) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  const listbox = document.getElementById(listboxId);
  const toggleBtn = container.querySelector(".combobox-toggle");

  let items = [];
  let filtered = [];
  let selectedValue = "";
  let highlightedIdx = -1;
  let isOpen = false;

  function renderOptions(query = "") {
    const q = normalizeSearchKey(query);
    filtered = q
      ? items.filter((item) => normalizeSearchKey(item).includes(q))
      : items.slice();

    listbox.innerHTML = "";
    if (!filtered.length) {
      const li = document.createElement("li");
      li.className = "combobox-empty";
      li.textContent = "No matching NWM item found";
      listbox.appendChild(li);
      highlightedIdx = -1;
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "combobox-option";
      li.role = "option";
      li.id = `${listboxId}-opt-${idx}`;
      li.setAttribute("aria-selected", item === selectedValue ? "true" : "false");
      if (idx === highlightedIdx) li.classList.add("is-highlighted");

      const nameSpan = document.createElement("span");
      nameSpan.textContent = item;
      const unitSpan = document.createElement("span");
      unitSpan.className = "combobox-option-unit";
      unitSpan.textContent = state.itemLatestUnit.get(item) || "";

      li.append(nameSpan, unitSpan);
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(item);
      });
      frag.appendChild(li);
    });
    listbox.appendChild(frag);
  }

  function open(showAll = false) {
    isOpen = true;
    input.setAttribute("aria-expanded", "true");
    listbox.hidden = false;
    highlightedIdx = -1;
    renderOptions(showAll ? "" : input.value);
    const activeEl = listbox.querySelector('[aria-selected="true"]');
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function close(restoreSelected = true) {
    isOpen = false;
    input.setAttribute("aria-expanded", "false");
    listbox.hidden = true;
    highlightedIdx = -1;
    if (restoreSelected && selectedValue) {
      input.value = selectedValue;
    }
  }

  function choose(item) {
    selectedValue = item;
    input.value = item;
    close(false);
    onSelect(item);
  }

  function updateHighlight(nextIdx) {
    if (!filtered.length) return;
    highlightedIdx = (nextIdx + filtered.length) % filtered.length;
    const opts = listbox.querySelectorAll(".combobox-option");
    opts.forEach((el, idx) => {
      el.classList.toggle("is-highlighted", idx === highlightedIdx);
    });
    if (opts[highlightedIdx]) {
      opts[highlightedIdx].scrollIntoView({ block: "nearest" });
    }
  }

  input.addEventListener("focus", () => {
    input.select();
    open(true);
  });

  input.addEventListener("input", () => {
    if (!isOpen) open(false);
    highlightedIdx = 0;
    renderOptions(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) open(true);
      updateHighlight(highlightedIdx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) open(true);
      updateHighlight(highlightedIdx <= 0 ? filtered.length - 1 : highlightedIdx - 1);
    } else if (e.key === "Enter") {
      if (isOpen && filtered.length) {
        e.preventDefault();
        const pick = highlightedIdx >= 0 ? filtered[highlightedIdx] : filtered[0];
        if (pick) choose(pick);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      input.blur();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!container.contains(document.activeElement)) {
        close(true);
      }
    }, 120);
  });

  toggleBtn?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (isOpen) {
      close(true);
    } else {
      input.focus();
      open(true);
    }
  });

  return {
    setItems(newItems) {
      items = newItems.slice();
    },
    setValue(val) {
      selectedValue = val || "";
      input.value = selectedValue;
    },
    getValue() {
      return selectedValue;
    },
  };
}

// ---------------------------------------------------------------------------
// Date Range Controls (strict dd/mm/yy display + native picker bridge)
// ---------------------------------------------------------------------------

function syncDateInputsUI() {
  const fromDisplay = document.getElementById("from-date-display");
  const toDisplay = document.getElementById("to-date-display");
  const fromNative = document.getElementById("from-date-native");
  const toNative = document.getElementById("to-date-native");
  const errorEl = document.getElementById("date-error");

  fromDisplay.value = formatIsoDDMMYY(state.fromIso);
  toDisplay.value = formatIsoDDMMYY(state.toIso);
  fromNative.value = state.fromIso;
  toNative.value = state.toIso;
  if (state.rawData?.date_range) {
    fromNative.min = state.rawData.date_range.min_iso || "";
    fromNative.max = state.rawData.date_range.max_iso || "";
    toNative.min = state.rawData.date_range.min_iso || "";
    toNative.max = state.rawData.date_range.max_iso || "";
  }
  errorEl.hidden = true;
  errorEl.textContent = "";

  document.querySelectorAll(".date-presets .preset-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.preset === state.activePreset);
  });
}

function applyPreset(presetKey) {
  const range = state.rawData?.date_range;
  if (!range?.max_iso || !range?.min_iso) return;

  const minIso = range.min_iso;
  const maxIso = range.max_iso;
  let fromIso = minIso;
  const toIso = maxIso;

  if (presetKey === "14d") {
    fromIso = clampIso(subtractDaysIso(maxIso, 13), minIso, maxIso);
  } else if (presetKey === "30d") {
    fromIso = clampIso(subtractDaysIso(maxIso, 29), minIso, maxIso);
  } else if (presetKey === "60d") {
    fromIso = clampIso(subtractDaysIso(maxIso, 59), minIso, maxIso);
  } else if (presetKey === "90d") {
    fromIso = clampIso(subtractDaysIso(maxIso, 89), minIso, maxIso);
  } else if (presetKey === "ytd") {
    const latestYear = toPlainDate(maxIso).year;
    fromIso = clampIso(`${latestYear}-01-01`, minIso, maxIso);
  } else if (presetKey === "all") {
    fromIso = minIso;
  }

  state.fromIso = fromIso;
  state.toIso = toIso;
  state.activePreset = presetKey;
  syncDateInputsUI();
  renderAllViews();
}

function commitCustomDateRange(newFromIso, newToIso) {
  const errorEl = document.getElementById("date-error");
  if (!newFromIso || !newToIso) {
    errorEl.textContent = "Please enter valid dates in dd/mm/yy format (e.g. 19/11/26).";
    errorEl.hidden = false;
    return;
  }
  if (newFromIso > newToIso) {
    errorEl.textContent = "From Date must be on or before To Date.";
    errorEl.hidden = false;
    return;
  }
  state.fromIso = newFromIso;
  state.toIso = newToIso;
  state.activePreset = "custom";
  syncDateInputsUI();
  renderAllViews();
}

// ---------------------------------------------------------------------------
// Dynamic Year Checkboxes
// ---------------------------------------------------------------------------

function renderYearCheckboxes() {
  const container = document.getElementById("year-checkboxes");
  const years = state.rawData?.years || [];
  container.innerHTML = "";

  // Ensure at least all years selected on initial load
  if (state.selectedYears.size === 0) {
    years.forEach((y) => state.selectedYears.add(y));
  } else {
    // Keep only valid years
    for (const y of [...state.selectedYears]) {
      if (!years.includes(y)) state.selectedYears.delete(y);
    }
    if (state.selectedYears.size === 0) {
      years.forEach((y) => state.selectedYears.add(y));
    }
  }

  years.forEach((year, idx) => {
    const label = document.createElement("label");
    label.className = "year-chip";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(year);
    cb.checked = state.selectedYears.has(year);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        state.selectedYears.add(year);
      } else {
        state.selectedYears.delete(year);
      }
      renderMonthlyComparison();
    });

    const swatch = document.createElement("span");
    swatch.className = "year-swatch";
    swatch.style.backgroundColor = YEAR_PALETTE[idx % YEAR_PALETTE.length];

    const txt = document.createElement("span");
    txt.textContent = String(year);

    label.append(cb, swatch, txt);
    container.appendChild(label);
  });
}

// ---------------------------------------------------------------------------
// Render KPI Cards & Supply Drop Alert
// ---------------------------------------------------------------------------

function renderKPIs(records) {
  const itemUnit = state.itemLatestUnit.get(state.selectedItem) || "";
  const priceUnitLabel = getPriceUnitLabel(itemUnit);
  const qtyUnitLabel = itemUnit || "Units";

  document.getElementById("selected-item-unit-badge").textContent =
    isKgUnit(itemUnit)
      ? `NWM Unit: Kg · Showing ${priceUnitLabel}`
      : `NWM Unit: ${qtyUnitLabel} · Showing ${priceUnitLabel}`;

  document.getElementById("date-range-summary").textContent =
    `${formatIsoDDMMYY(state.fromIso)} → ${formatIsoDDMMYY(state.toIso)} · ${records.length} trading ${records.length === 1 ? "day" : "days"}`;

  const alertBanner = document.getElementById("supply-alert-banner");
  const alertText = document.getElementById("supply-alert-text");
  const volCard = document.getElementById("kpi-volume-card");
  const supplyBadge = document.getElementById("kpi-supply-badge");

  const latestPriceEl = document.getElementById("kpi-latest-price");
  const latestPriceDateEl = document.getElementById("kpi-latest-price-date");
  const latestPriceDeltaEl = document.getElementById("kpi-latest-price-delta");
  const latestVolEl = document.getElementById("kpi-latest-volume");
  const latestVolMetaEl = document.getElementById("kpi-latest-volume-meta");
  const avgPriceEl = document.getElementById("kpi-avg-price");
  const rangeDaysEl = document.getElementById("kpi-range-days");
  const spreadEl = document.getElementById("kpi-price-spread");
  const totalVolEl = document.getElementById("kpi-total-volume");
  const volUnitEl = document.getElementById("kpi-volume-unit");
  const avgVolEl = document.getElementById("kpi-avg-volume");

  volUnitEl.textContent = qtyUnitLabel;
  rangeDaysEl.textContent = `${records.length} trading ${records.length === 1 ? "day" : "days"}`;

  if (!records.length) {
    latestPriceDateEl.textContent = "--/--/--";
    latestPriceEl.textContent = "—";
    latestPriceDeltaEl.textContent = "No records in selected range";
    latestVolEl.textContent = "—";
    latestVolMetaEl.textContent = "No volume recorded";
    avgPriceEl.textContent = "—";
    spreadEl.textContent = "Low – High spread: —";
    totalVolEl.textContent = "—";
    avgVolEl.textContent = "Daily average: —";
    alertBanner.hidden = true;
    volCard.classList.remove("is-alert");
    supplyBadge.textContent = "No Data";
    supplyBadge.className = "kpi-badge is-neutral";
    return;
  }

  // Latest NORM price record in range
  const priceRecords = records.filter((r) => r.norm_price !== null && r.norm_price !== undefined);
  if (priceRecords.length) {
    const latestP = priceRecords[priceRecords.length - 1];
    const latestPriceVal = convertPrice(latestP.norm_price, latestP.unit);
    const pUnit = getPriceUnitLabel(latestP.unit);
    latestPriceDateEl.textContent = formatIsoDDMMYY(latestP.date_iso);
    latestPriceEl.innerHTML = `${formatPrice(latestPriceVal)}<span class="kpi-unit">${pUnit}</span>`;

    // Prior trading day in item history (even if just before range start)
    const allItemRecs = state.recordsByItem.get(state.selectedItem) || [];
    const idxInAll = allItemRecs.indexOf(latestP);
    let priorP = null;
    for (let j = idxInAll - 1; j >= 0; j--) {
      if (allItemRecs[j].norm_price !== null && allItemRecs[j].norm_price !== undefined) {
        priorP = allItemRecs[j];
        break;
      }
    }
    if (priorP) {
      const prevVal = convertPrice(priorP.norm_price, priorP.unit);
      const diff = latestPriceVal - prevVal;
      const pct = prevVal > 0 ? (diff / prevVal) * 100 : null;
      const priorDisp = formatIsoDDMMYY(priorP.date_iso);
      if (Math.abs(diff) < 1e-6) {
        latestPriceDeltaEl.textContent = `Unchanged vs ${priorDisp}`;
      } else {
        const cls = diff > 0 ? "delta-up" : "delta-down";
        const arrow = diff > 0 ? "▲" : "▼";
        const sign = diff > 0 ? "+" : "-";
        latestPriceDeltaEl.innerHTML =
          `<span class="${cls}">${arrow} ${sign}Rs ${formatPrice(Math.abs(diff))} (${formatSignedPct(pct)})</span> vs ${priorDisp}`;
      }
    } else {
      latestPriceDeltaEl.textContent = "First recorded trading day";
    }
  } else {
    latestPriceDateEl.textContent = formatIsoDDMMYY(records[records.length - 1].date_iso);
    latestPriceEl.textContent = "—";
    latestPriceDeltaEl.textContent = "NORM price not reported";
  }

  // Latest volume sold & >30% Supply Drop Alert
  const volRecords = records.filter((r) => r.qty_sold !== null && r.qty_sold !== undefined);
  if (volRecords.length) {
    const latestV = volRecords[volRecords.length - 1];
    const vUnit = latestV.unit || qtyUnitLabel;
    const latestDateDisp = formatIsoDDMMYY(latestV.date_iso);
    latestVolEl.innerHTML = `${formatQty(latestV.qty_sold)}<span class="kpi-unit">${vUnit}</span>`;

    if (latestV._avg7Qty !== null) {
      const pct = latestV._dropPct;
      if (latestV._isSupplyDrop) {
        volCard.classList.add("is-alert");
        supplyBadge.textContent = `Supply Drop ${pct.toFixed(0)}%`;
        supplyBadge.className = "kpi-badge is-drop";
        latestVolMetaEl.innerHTML =
          `<span class="delta-drop">${formatSignedPct(pct)} vs 7-day avg</span> (${formatQty(latestV._avg7Qty)} ${vUnit}) · ${latestDateDisp}`;

        alertBanner.hidden = false;
        alertText.innerHTML =
          `<strong>Supply Drop Alert (&gt;30%):</strong> <strong>${escapeHtml(state.selectedItem)}</strong> volume on ` +
          `<strong>${escapeHtml(latestDateDisp)}</strong> fell to <strong>${formatQty(latestV.qty_sold)} ${escapeHtml(vUnit)}</strong> ` +
          `(${formatSignedPct(pct)} below its trailing ${latestV._avg7Count}-day average of ${formatQty(latestV._avg7Qty)} ${escapeHtml(vUnit)}).`;
      } else {
        volCard.classList.remove("is-alert");
        supplyBadge.textContent = "Supply Normal";
        supplyBadge.className = "kpi-badge";
        const signCls = pct >= 0 ? "delta-down" : "delta-up";
        latestVolMetaEl.innerHTML =
          `<span class="${signCls}">${formatSignedPct(pct)} vs 7-day avg</span> (${formatQty(latestV._avg7Qty)} ${vUnit}) · ${latestDateDisp}`;
        alertBanner.hidden = true;
      }
    } else {
      volCard.classList.remove("is-alert");
      supplyBadge.textContent = latestDateDisp;
      supplyBadge.className = "kpi-badge is-neutral";
      latestVolMetaEl.textContent = `Recorded on ${latestDateDisp} (insufficient 7-day baseline)`;
      alertBanner.hidden = true;
    }
  } else {
    latestVolEl.textContent = "—";
    latestVolMetaEl.textContent = "No quantity sold reported in range";
    volCard.classList.remove("is-alert");
    supplyBadge.textContent = "No Qty";
    supplyBadge.className = "kpi-badge is-neutral";
    alertBanner.hidden = true;
  }

  // Range Average NORM & Low-High Spread
  const normVals = priceRecords.map((r) => convertPrice(r.norm_price, r.unit));
  const lowVals = records
    .filter((r) => r.low_price !== null && r.low_price !== undefined)
    .map((r) => convertPrice(r.low_price, r.unit));
  const highVals = records
    .filter((r) => r.high_price !== null && r.high_price !== undefined)
    .map((r) => convertPrice(r.high_price, r.unit));

  if (normVals.length) {
    const avgNorm = normVals.reduce((a, b) => a + b, 0) / normVals.length;
    avgPriceEl.innerHTML = `${formatPrice(avgNorm)}<span class="kpi-unit">${priceUnitLabel}</span>`;
  } else {
    avgPriceEl.textContent = "—";
  }

  if (lowVals.length && highVals.length) {
    const minLow = Math.min(...lowVals);
    const maxHigh = Math.max(...highVals);
    spreadEl.textContent = `Range Low – High: ${formatPrice(minLow)} – ${formatPrice(maxHigh)} ${priceUnitLabel}`;
  } else {
    spreadEl.textContent = "Range Low – High: —";
  }

  // Range Total & Daily Avg Volume
  if (volRecords.length) {
    const totalQty = volRecords.reduce((sum, r) => sum + Number(r.qty_sold), 0);
    const avgQty = totalQty / volRecords.length;
    totalVolEl.innerHTML = `${formatQty(totalQty)}<span class="kpi-unit">${qtyUnitLabel}</span>`;
    avgVolEl.textContent = `Daily average: ${formatQty(avgQty)} ${qtyUnitLabel} across ${volRecords.length} ${volRecords.length === 1 ? "day" : "days"}`;
  } else {
    totalVolEl.textContent = "—";
    avgVolEl.textContent = "Daily average: —";
  }
}

// ---------------------------------------------------------------------------
// Daily Price & Volume Bar Charts
// ---------------------------------------------------------------------------

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    state.charts[key] = null;
  }
}

function aggregateRecordsByYearMonth(records) {
  const map = new Map();
  for (const r of records) {
    const ym = r.date_iso.slice(0, 7); // YYYY-MM
    const year = Number(ym.slice(0, 4));
    const month = Number(ym.slice(5, 7));
    let b = map.get(ym);
    if (!b) {
      b = {
        ym,
        year,
        month,
        label: `${MONTH_NAMES[month - 1]} ${String(year % 100).padStart(2, "0")}`,
        firstIso: r.date_iso,
        lastIso: r.date_iso,
        totalQty: 0,
        qtyCount: 0,
        lowSum: 0,
        lowCount: 0,
        highSum: 0,
        highCount: 0,
        normSum: 0,
        normCount: 0,
        tradingDays: 0,
        unit: r.unit,
      };
      map.set(ym, b);
    }
    if (r.date_iso < b.firstIso) b.firstIso = r.date_iso;
    if (r.date_iso > b.lastIso) b.lastIso = r.date_iso;
    if (r.unit) b.unit = r.unit;
    b.tradingDays += 1;
    if (r.qty_sold !== null && r.qty_sold !== undefined) {
      b.totalQty += Number(r.qty_sold);
      b.qtyCount += 1;
    }
    const low = convertPrice(r.low_price, r.unit);
    if (low !== null) {
      b.lowSum += low;
      b.lowCount += 1;
    }
    const high = convertPrice(r.high_price, r.unit);
    if (high !== null) {
      b.highSum += high;
      b.highCount += 1;
    }
    const norm = convertPrice(r.norm_price, r.unit);
    if (norm !== null) {
      b.normSum += norm;
      b.normCount += 1;
    }
  }
  return [...map.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function renderDailyCharts(records) {
  const emptyEl = document.getElementById("daily-empty-state");
  const stackEl = document.querySelector(".daily-charts-stack");
  const dropDot = document.getElementById("legend-drop-dot");
  const dropLbl = document.getElementById("legend-drop-label");

  const itemUnit = state.itemLatestUnit.get(state.selectedItem) || "";
  const priceUnitLabel = getPriceUnitLabel(itemUnit);
  const qtyUnitLabel = itemUnit || "Units";
  const isMonthly = state.primaryGrouping === "month";

  if (dropDot) dropDot.hidden = isMonthly;
  if (dropLbl) dropLbl.hidden = isMonthly;

  document.getElementById("daily-charts-subtitle").textContent = isMonthly
    ? `Regrouped by Month (${formatIsoDDMMYY(state.fromIso)} → ${formatIsoDDMMYY(state.toIso)}) — Monthly Average NORM Price & Total Volume Sold.`
    : `Daily AMB trading records (${formatIsoDDMMYY(state.fromIso)} → ${formatIsoDDMMYY(state.toIso)}) — closed/unrecorded days omitted.`;

  document.getElementById("price-chart-title").textContent = isMonthly
    ? `${state.selectedItem} — Monthly Average NORM Price (${priceUnitLabel})`
    : `${state.selectedItem} — Most Common Price (NORM, ${priceUnitLabel})`;
  document.getElementById("volume-chart-title").textContent = isMonthly
    ? `${state.selectedItem} — Monthly Total Volume Sold (${qtyUnitLabel})`
    : `${state.selectedItem} — Daily Volume Sold (${qtyUnitLabel})`;

  if (!records.length) {
    destroyChart("dailyPrice");
    destroyChart("dailyVolume");
    stackEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  stackEl.hidden = false;
  emptyEl.hidden = true;

  if (isMonthly) {
    const monthlyBuckets = aggregateRecordsByYearMonth(records);
    const labels = monthlyBuckets.map((b) => b.label);
    const normData = monthlyBuckets.map((b) => (b.normCount ? b.normSum / b.normCount : null));
    const qtyData = monthlyBuckets.map((b) => (b.qtyCount ? b.totalQty : null));

    destroyChart("dailyPrice");
    const priceCtx = document.getElementById("daily-price-chart").getContext("2d");
    state.charts.dailyPrice = new Chart(priceCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: `Avg NORM Price (${priceUnitLabel})`,
            data: normData,
            backgroundColor: "rgba(5, 150, 105, 0.85)",
            hoverBackgroundColor: "rgba(4, 120, 87, 0.96)",
            borderColor: "#047857",
            borderWidth: 1,
            borderRadius: 5,
            maxBarThickness: 44,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0b291f",
            titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
            bodyFont: { family: "Inter, sans-serif", size: 12 },
            padding: 10,
            callbacks: {
              title(items) {
                const b = monthlyBuckets[items[0].dataIndex];
                return `${MONTH_NAMES[b.month - 1]} ${b.year} (${formatIsoDDMMYY(b.firstIso)} – ${formatIsoDDMMYY(b.lastIso)})`;
              },
              label(ctx) {
                const b = monthlyBuckets[ctx.dataIndex];
                return `Avg NORM: ${b.normCount ? formatPrice(b.normSum / b.normCount) : "—"} ${priceUnitLabel}`;
              },
              afterLabel(ctx) {
                const b = monthlyBuckets[ctx.dataIndex];
                const lines = [];
                if (b.lowCount || b.highCount) {
                  lines.push(
                    `Avg Low – High: ${b.lowCount ? formatPrice(b.lowSum / b.lowCount) : "—"} – ${b.highCount ? formatPrice(b.highSum / b.highCount) : "—"} ${priceUnitLabel}`
                  );
                }
                if (b.qtyCount) {
                  lines.push(`Total Qty Sold: ${formatQty(b.totalQty)} ${qtyUnitLabel}`);
                }
                lines.push(`Trading Days: ${b.tradingDays}`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxRotation: 45,
              minRotation: 0,
              autoSkip: true,
              maxTicksLimit: 24,
              font: { family: "JetBrains Mono, monospace", size: 11 },
              color: "#4a5d54",
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(197, 208, 199, 0.45)" },
            title: { display: true, text: priceUnitLabel, color: "#4a5d54", font: { size: 11, weight: "600" } },
            ticks: { font: { family: "JetBrains Mono, monospace", size: 11 }, color: "#4a5d54" },
          },
        },
      },
    });

    destroyChart("dailyVolume");
    const volCtx = document.getElementById("daily-volume-chart").getContext("2d");
    state.charts.dailyVolume = new Chart(volCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: `Total Volume Sold (${qtyUnitLabel})`,
            data: qtyData,
            backgroundColor: "rgba(2, 132, 199, 0.8)",
            borderColor: "#0369a1",
            borderWidth: 1,
            borderRadius: 5,
            maxBarThickness: 44,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0b291f",
            titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
            bodyFont: { family: "Inter, sans-serif", size: 12 },
            padding: 10,
            callbacks: {
              title(items) {
                const b = monthlyBuckets[items[0].dataIndex];
                return `${MONTH_NAMES[b.month - 1]} ${b.year} (${formatIsoDDMMYY(b.firstIso)} – ${formatIsoDDMMYY(b.lastIso)})`;
              },
              label(ctx) {
                const b = monthlyBuckets[ctx.dataIndex];
                return `Total Volume: ${b.qtyCount ? formatQty(b.totalQty) : "—"} ${qtyUnitLabel}`;
              },
              afterLabel(ctx) {
                const b = monthlyBuckets[ctx.dataIndex];
                const lines = [];
                if (b.qtyCount) {
                  lines.push(`Daily Avg: ${formatQty(b.totalQty / b.qtyCount)} ${qtyUnitLabel}`);
                }
                lines.push(`Trading Days: ${b.tradingDays}`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxRotation: 45,
              minRotation: 0,
              autoSkip: true,
              maxTicksLimit: 24,
              font: { family: "JetBrains Mono, monospace", size: 11 },
              color: "#4a5d54",
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(197, 208, 199, 0.45)" },
            title: { display: true, text: qtyUnitLabel, color: "#4a5d54", font: { size: 11, weight: "600" } },
            ticks: {
              font: { family: "JetBrains Mono, monospace", size: 11 },
              color: "#4a5d54",
              callback: (v) => Number(v).toLocaleString("en-US"),
            },
          },
        },
      },
    });
    return;
  }

  const labels = records.map((r) => formatIsoDDMMYY(r.date_iso));
  const normData = records.map((r) => convertPrice(r.norm_price, r.unit));
  const qtyData = records.map((r) => (r.qty_sold !== null && r.qty_sold !== undefined ? r.qty_sold : null));
  const volColors = records.map((r) =>
    r._isSupplyDrop ? "rgba(220, 38, 38, 0.85)" : "rgba(2, 132, 199, 0.78)"
  );
  const volBorders = records.map((r) =>
    r._isSupplyDrop ? "#b91c1c" : "#0369a1"
  );

  destroyChart("dailyPrice");
  const priceCtx = document.getElementById("daily-price-chart").getContext("2d");
  state.charts.dailyPrice = new Chart(priceCtx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `NORM Price (${priceUnitLabel})`,
          data: normData,
          backgroundColor: "rgba(5, 150, 105, 0.82)",
          hoverBackgroundColor: "rgba(4, 120, 87, 0.95)",
          borderColor: "#047857",
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 36,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b291f",
          titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, sans-serif", size: 12 },
          padding: 10,
          callbacks: {
            title(items) {
              const rec = records[items[0].dataIndex];
              return `Date: ${formatIsoDDMMYY(rec.date_iso)}`;
            },
            label(ctx) {
              const rec = records[ctx.dataIndex];
              const u = getPriceUnitLabel(rec.unit);
              const norm = convertPrice(rec.norm_price, rec.unit);
              return `NORM Price: ${formatPrice(norm)} ${u}`;
            },
            afterLabel(ctx) {
              const rec = records[ctx.dataIndex];
              const u = getPriceUnitLabel(rec.unit);
              const low = convertPrice(rec.low_price, rec.unit);
              const high = convertPrice(rec.high_price, rec.unit);
              const lines = [];
              if (low !== null || high !== null) {
                lines.push(`Low – High: ${formatPrice(low)} – ${formatPrice(high)} ${u}`);
              }
              if (rec.qty_sold !== null && rec.qty_sold !== undefined) {
                lines.push(`Volume Sold: ${formatQty(rec.qty_sold)} ${rec.unit || qtyUnitLabel}`);
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 18,
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: {
            display: true,
            text: priceUnitLabel,
            color: "#4a5d54",
            font: { size: 11, weight: "600" },
          },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
      },
    },
  });

  destroyChart("dailyVolume");
  const volCtx = document.getElementById("daily-volume-chart").getContext("2d");
  state.charts.dailyVolume = new Chart(volCtx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `Volume Sold (${qtyUnitLabel})`,
          data: qtyData,
          backgroundColor: volColors,
          borderColor: volBorders,
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 36,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b291f",
          titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, sans-serif", size: 12 },
          padding: 10,
          callbacks: {
            title(items) {
              const rec = records[items[0].dataIndex];
              return `Date: ${formatIsoDDMMYY(rec.date_iso)}`;
            },
            label(ctx) {
              const rec = records[ctx.dataIndex];
              return `Volume Sold: ${formatQty(rec.qty_sold)} ${rec.unit || qtyUnitLabel}`;
            },
            afterLabel(ctx) {
              const rec = records[ctx.dataIndex];
              const lines = [];
              if (rec._avg7Qty !== null) {
                lines.push(
                  `7-Day Avg: ${formatQty(rec._avg7Qty)} ${rec.unit || qtyUnitLabel} (${formatSignedPct(rec._dropPct)})`
                );
                if (rec._isSupplyDrop) {
                  lines.push("ALERT: >30% supply drop vs 7-day average");
                }
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 18,
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: {
            display: true,
            text: qtyUnitLabel,
            color: "#4a5d54",
            font: { size: 11, weight: "600" },
          },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
            callback: (v) => Number(v).toLocaleString("en-US"),
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Monthly Comparison View (Dynamic Year Checkboxes + Grouped Bar + Table)
// ---------------------------------------------------------------------------

function getActiveMonthNumbersInRange() {
  if (!state.fromIso || !state.toIso) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const start = toPlainDate(state.fromIso);
  const end = toPlainDate(state.toIso);
  if (daysBetweenIso(state.fromIso, state.toIso) >= 364) {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  }
  const months = new Set();
  let cur = Temporal.PlainDate.from({ year: start.year, month: start.month, day: 1 });
  const endMonthStart = Temporal.PlainDate.from({ year: end.year, month: end.month, day: 1 });
  while (Temporal.PlainDate.compare(cur, endMonthStart) <= 0) {
    months.add(cur.month);
    cur = cur.add({ months: 1 });
  }
  return [...months].sort((a, b) => a - b);
}

function renderMonthlyComparison() {
  const allItemRecs = state.recordsByItem.get(state.selectedItem) || [];
  const allYears = state.rawData?.years || [];
  const checkedYears = allYears.filter((y) => state.selectedYears.has(y));
  const itemUnit = state.itemLatestUnit.get(state.selectedItem) || "";
  const priceUnitLabel = getPriceUnitLabel(itemUnit);
  const qtyUnitLabel = itemUnit || "Units";

  const activeMonths = getActiveMonthNumbersInRange();
  const activeMonthSet = new Set(activeMonths);

  // Filter records according to checked years & monthly scope setting
  const scopedRecords = allItemRecs.filter((r) => {
    const year = Number(r.date_iso.slice(0, 4));
    if (!state.selectedYears.has(year)) return false;
    if (state.monthlyMatchMonths) {
      const month = Number(r.date_iso.slice(5, 7));
      return activeMonthSet.has(month);
    }
    return r.date_iso >= state.fromIso && r.date_iso <= state.toIso;
  });

  // Aggregate by (year, month)
  const buckets = new Map();
  for (const r of scopedRecords) {
    const year = Number(r.date_iso.slice(0, 4));
    const month = Number(r.date_iso.slice(5, 7));
    const key = `${year}-${String(month).padStart(2, "0")}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        year,
        month,
        totalQty: 0,
        qtyCount: 0,
        lowSum: 0,
        lowCount: 0,
        highSum: 0,
        highCount: 0,
        normSum: 0,
        normCount: 0,
        tradingDays: 0,
      };
      buckets.set(key, b);
    }
    b.tradingDays += 1;
    if (r.qty_sold !== null && r.qty_sold !== undefined) {
      b.totalQty += Number(r.qty_sold);
      b.qtyCount += 1;
    }
    const low = convertPrice(r.low_price, r.unit);
    if (low !== null) {
      b.lowSum += low;
      b.lowCount += 1;
    }
    const high = convertPrice(r.high_price, r.unit);
    if (high !== null) {
      b.highSum += high;
      b.highCount += 1;
    }
    const norm = convertPrice(r.norm_price, r.unit);
    if (norm !== null) {
      b.normSum += norm;
      b.normCount += 1;
    }
  }

  // Update subtitle
  const subtitleEl = document.getElementById("monthly-subtitle");
  if (!checkedYears.length) {
    subtitleEl.textContent = "Select one or more years above to compare monthly trends.";
  } else if (state.monthlyMatchMonths) {
    const monthSummary =
      activeMonths.length === 12
        ? "Jan–Dec"
        : activeMonths.map((m) => MONTH_NAMES[m - 1]).join(", ");
    subtitleEl.textContent = `${state.selectedItem} · Comparing ${monthSummary} across years ${checkedYears.join(", ")} (${priceUnitLabel})`;
  } else {
    subtitleEl.textContent = `${state.selectedItem} · Strict range ${formatIsoDDMMYY(state.fromIso)} – ${formatIsoDDMMYY(state.toIso)} · Years: ${checkedYears.join(", ")} (${priceUnitLabel})`;
  }

  // Determine months shown on X-axis of grouped bar chart
  const chartMonths = state.monthlyMatchMonths
    ? activeMonths
    : [...new Set([...buckets.values()].map((b) => b.month))].sort((a, b) => a - b);
  const effectiveMonths = chartMonths.length ? chartMonths : activeMonths;

  const datasets = checkedYears.map((year) => {
    const colorIdx = allYears.indexOf(year);
    const color = YEAR_PALETTE[(colorIdx >= 0 ? colorIdx : 0) % YEAR_PALETTE.length];
    return {
      label: String(year),
      backgroundColor: `${color}cc`,
      borderColor: color,
      borderWidth: 1,
      borderRadius: 4,
      maxBarThickness: 32,
      data: effectiveMonths.map((m) => {
        const key = `${year}-${String(m).padStart(2, "0")}`;
        const b = buckets.get(key);
        if (!b) return null;
        if (state.monthlyMetric === "qty") {
          return b.qtyCount ? b.totalQty : null;
        }
        return b.normCount ? b.normSum / b.normCount : null;
      }),
    };
  });

  destroyChart("monthly");
  const ctx = document.getElementById("monthly-comparison-chart").getContext("2d");
  const yLabel = state.monthlyMetric === "qty" ? `Total Qty (${qtyUnitLabel})` : `Avg NORM (${priceUnitLabel})`;

  state.charts.monthly = new Chart(ctx, {
    type: "bar",
    data: {
      labels: effectiveMonths.map((m) => MONTH_NAMES[m - 1]),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            pointStyle: "rectRounded",
            font: { family: "JetBrains Mono, monospace", size: 12, weight: "600" },
          },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            label(c) {
              const val = c.raw;
              if (val === null || val === undefined) return `${c.dataset.label}: No data`;
              if (state.monthlyMetric === "qty") {
                return `${c.dataset.label}: ${formatQty(val)} ${qtyUnitLabel}`;
              }
              return `${c.dataset.label}: ${formatPrice(val)} ${priceUnitLabel}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 12, weight: "600" }, color: "#4a5d54" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: yLabel, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
            callback: (v) => Number(v).toLocaleString("en-US"),
          },
        },
      },
    },
  });

  // Render Responsive Monthly Table
  const tbody = document.getElementById("monthly-table-body");
  tbody.innerHTML = "";
  const rows = [...buckets.values()].sort((a, b) => b.year - a.year || b.month - a.month);

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.style.textAlign = "center";
    td.style.color = "#6f8178";
    td.style.padding = "20px";
    td.textContent = "No monthly records match the selected item, years, and date range.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const thYear = document.createElement("th");
    thYear.scope = "row";
    thYear.textContent = String(r.year);

    const tdMonth = document.createElement("td");
    tdMonth.textContent = MONTH_NAMES[r.month - 1];

    const tdQty = document.createElement("td");
    tdQty.className = "num";
    tdQty.textContent = r.qtyCount ? `${formatQty(r.totalQty)} ${qtyUnitLabel}` : "—";

    const tdLow = document.createElement("td");
    tdLow.className = "num";
    tdLow.textContent = r.lowCount ? `${formatPrice(r.lowSum / r.lowCount)} ${priceUnitLabel}` : "—";

    const tdHigh = document.createElement("td");
    tdHigh.className = "num";
    tdHigh.textContent = r.highCount ? `${formatPrice(r.highSum / r.highCount)} ${priceUnitLabel}` : "—";

    const tdNorm = document.createElement("td");
    tdNorm.className = "num norm-cell";
    tdNorm.textContent = r.normCount ? `${formatPrice(r.normSum / r.normCount)} ${priceUnitLabel}` : "—";

    const tdDays = document.createElement("td");
    tdDays.className = "num";
    tdDays.textContent = String(r.tradingDays);

    tr.append(thYear, tdMonth, tdQty, tdLow, tdHigh, tdNorm, tdDays);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Side-by-Side Comparison View
// ---------------------------------------------------------------------------

function summarizeItemForCompare(itemName, recs) {
  const unit = state.itemLatestUnit.get(itemName) || "";
  const pLabel = getPriceUnitLabel(unit);
  const qLabel = unit || "Units";
  const normRecs = recs.filter((r) => r.norm_price !== null && r.norm_price !== undefined);
  const volRecs = recs.filter((r) => r.qty_sold !== null && r.qty_sold !== undefined);

  const latestNormRec = normRecs.length ? normRecs[normRecs.length - 1] : null;
  const latestNorm = latestNormRec ? convertPrice(latestNormRec.norm_price, latestNormRec.unit) : null;
  const avgNorm = normRecs.length
    ? normRecs.reduce((s, r) => s + convertPrice(r.norm_price, r.unit), 0) / normRecs.length
    : null;
  const totalQty = volRecs.length ? volRecs.reduce((s, r) => s + Number(r.qty_sold), 0) : null;

  return {
    itemName,
    pLabel,
    qLabel,
    latestNorm,
    latestDate: latestNormRec ? formatIsoDDMMYY(latestNormRec.date_iso) : "--/--/--",
    avgNorm,
    totalQty,
    tradingDays: recs.length,
  };
}

function renderSideBySideComparison() {
  const itemA = state.compareItemA;
  const itemB = state.compareItemB;
  const recsA = getItemRecordsInRange(itemA);
  const recsB = getItemRecordsInRange(itemB);

  const sumA = summarizeItemForCompare(itemA, recsA);
  const sumB = summarizeItemForCompare(itemB, recsB);

  document.getElementById("compare-subtitle").textContent =
    `${itemA} vs ${itemB} · ${formatIsoDDMMYY(state.fromIso)} → ${formatIsoDDMMYY(state.toIso)}`;

  const summaryGrid = document.getElementById("compare-summary-grid");
  summaryGrid.innerHTML = [
    { tag: "Item A", cls: "compare-stat-card--a", s: sumA },
    { tag: "Item B", cls: "compare-stat-card--b", s: sumB },
  ]
    .map(
      ({ cls, s }) => `
      <div class="compare-stat-card ${cls}">
        <div class="compare-stat-header">
          <span class="compare-stat-title">${escapeHtml(s.itemName)}</span>
          <span class="kpi-date-chip">Latest: ${escapeHtml(s.latestDate)}</span>
        </div>
        <div class="compare-metrics-row">
          <div>
            <div class="compare-metric-label">Latest NORM</div>
            <div class="compare-metric-val">${s.latestNorm !== null ? `${formatPrice(s.latestNorm)} ${escapeHtml(s.pLabel)}` : "—"}</div>
          </div>
          <div>
            <div class="compare-metric-label">Range Avg</div>
            <div class="compare-metric-val">${s.avgNorm !== null ? `${formatPrice(s.avgNorm)} ${escapeHtml(s.pLabel)}` : "—"}</div>
          </div>
          <div>
            <div class="compare-metric-label">Total Qty</div>
            <div class="compare-metric-val">${s.totalQty !== null ? `${formatQty(s.totalQty)} ${escapeHtml(s.qLabel)}` : "—"}</div>
          </div>
          <div>
            <div class="compare-metric-label">Trading Days</div>
            <div class="compare-metric-val">${s.tradingDays}</div>
          </div>
        </div>
      </div>`
    )
    .join("");

  const isMonthly = state.compareGrouping === "month";
  let labels;
  let tooltipTitles;
  let priceA;
  let priceB;
  let qtyA;
  let qtyB;

  if (isMonthly) {
    const aggA = new Map(aggregateRecordsByYearMonth(recsA).map((b) => [b.ym, b]));
    const aggB = new Map(aggregateRecordsByYearMonth(recsB).map((b) => [b.ym, b]));
    const unionYms = [...new Set([...aggA.keys(), ...aggB.keys()])].sort();
    labels = unionYms.map((ym) => {
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      return `${MONTH_NAMES[m - 1]} ${String(y % 100).padStart(2, "0")}`;
    });
    tooltipTitles = unionYms.map((ym) => {
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      return `${MONTH_NAMES[m - 1]} ${y}`;
    });
    priceA = unionYms.map((ym) => {
      const b = aggA.get(ym);
      return b && b.normCount ? b.normSum / b.normCount : null;
    });
    priceB = unionYms.map((ym) => {
      const b = aggB.get(ym);
      return b && b.normCount ? b.normSum / b.normCount : null;
    });
    qtyA = unionYms.map((ym) => {
      const b = aggA.get(ym);
      return b && b.qtyCount ? b.totalQty : null;
    });
    qtyB = unionYms.map((ym) => {
      const b = aggB.get(ym);
      return b && b.qtyCount ? b.totalQty : null;
    });
  } else {
    // Align on union of dates in range (zero extrapolation: missing dates stay null)
    const mapA = new Map(recsA.map((r) => [r.date_iso, r]));
    const mapB = new Map(recsB.map((r) => [r.date_iso, r]));
    const unionDates = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
    labels = unionDates.map((iso) => formatIsoDDMMYY(iso));
    tooltipTitles = unionDates.map((iso) => `Date: ${formatIsoDDMMYY(iso)}`);

    priceA = unionDates.map((iso) => {
      const r = mapA.get(iso);
      return r ? convertPrice(r.norm_price, r.unit) : null;
    });
    priceB = unionDates.map((iso) => {
      const r = mapB.get(iso);
      return r ? convertPrice(r.norm_price, r.unit) : null;
    });
    qtyA = unionDates.map((iso) => {
      const r = mapA.get(iso);
      return r && r.qty_sold !== null && r.qty_sold !== undefined ? r.qty_sold : null;
    });
    qtyB = unionDates.map((iso) => {
      const r = mapB.get(iso);
      return r && r.qty_sold !== null && r.qty_sold !== undefined ? r.qty_sold : null;
    });
  }

  const priceTitleUnits =
    sumA.pLabel === sumB.pLabel ? sumA.pLabel : `${sumA.pLabel} / ${sumB.pLabel}`;
  const qtyTitleUnits =
    sumA.qLabel === sumB.qLabel ? sumA.qLabel : `${sumA.qLabel} / ${sumB.qLabel}`;

  document.getElementById("compare-price-title").textContent = isMonthly
    ? `Monthly Avg NORM Price Comparison (${priceTitleUnits})`
    : `NORM Price Comparison (${priceTitleUnits})`;
  document.getElementById("compare-volume-title").textContent = isMonthly
    ? `Monthly Total Volume Comparison (${qtyTitleUnits})`
    : `Daily Volume Comparison (${qtyTitleUnits})`;

  destroyChart("comparePrice");
  const pCtx = document.getElementById("compare-price-chart").getContext("2d");
  state.charts.comparePrice = new Chart(pCtx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${itemA} (${sumA.pLabel})`,
          data: priceA,
          backgroundColor: "rgba(5, 150, 105, 0.82)",
          borderColor: "#047857",
          borderWidth: 1,
          borderRadius: 3,
          maxBarThickness: 26,
        },
        {
          label: `${itemB} (${sumB.pLabel})`,
          data: priceB,
          backgroundColor: "rgba(217, 119, 6, 0.82)",
          borderColor: "#b45309",
          borderWidth: 1,
          borderRadius: 3,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { size: 11, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            title(items) {
              return tooltipTitles[items[0].dataIndex];
            },
            label(c) {
              const val = c.raw;
              const u = c.datasetIndex === 0 ? sumA.pLabel : sumB.pLabel;
              const name = c.datasetIndex === 0 ? itemA : itemB;
              return val === null || val === undefined
                ? `${name}: Not recorded`
                : `${name}: ${formatPrice(val)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
            font: { family: "JetBrains Mono, monospace", size: 10 },
            color: "#4a5d54",
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: priceTitleUnits, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: { font: { family: "JetBrains Mono, monospace", size: 10 }, color: "#4a5d54" },
        },
      },
    },
  });

  destroyChart("compareVolume");
  const vCtx = document.getElementById("compare-volume-chart").getContext("2d");
  state.charts.compareVolume = new Chart(vCtx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${itemA} (${sumA.qLabel})`,
          data: qtyA,
          backgroundColor: "rgba(5, 150, 105, 0.72)",
          borderColor: "#047857",
          borderWidth: 1,
          borderRadius: 3,
          maxBarThickness: 26,
        },
        {
          label: `${itemB} (${sumB.qLabel})`,
          data: qtyB,
          backgroundColor: "rgba(217, 119, 6, 0.72)",
          borderColor: "#b45309",
          borderWidth: 1,
          borderRadius: 3,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { size: 11, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            title(items) {
              return tooltipTitles[items[0].dataIndex];
            },
            label(c) {
              const val = c.raw;
              const u = c.datasetIndex === 0 ? sumA.qLabel : sumB.qLabel;
              const name = c.datasetIndex === 0 ? itemA : itemB;
              return val === null || val === undefined
                ? `${name}: Not recorded`
                : `${name}: ${formatQty(val)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
            font: { family: "JetBrains Mono, monospace", size: 10 },
            color: "#4a5d54",
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: qtyTitleUnits, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 10 },
            color: "#4a5d54",
            callback: (v) => Number(v).toLocaleString("en-US"),
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Pomme d'Amour Stacked Analysis (Terre + Serre)
// ---------------------------------------------------------------------------

function isPommeDamourItem(itemName) {
  return normalizeSearchKey(itemName).startsWith("pomme d'amour");
}

function renderPommeDamourStacked() {
  const sectionEl = document.getElementById("tomato-stacked-section");
  if (!state.rawData || !isPommeDamourItem(state.selectedItem)) {
    if (sectionEl) sectionEl.hidden = true;
    destroyChart("tomatoVolume");
    destroyChart("tomatoPrice");
    return;
  }
  if (sectionEl) sectionEl.hidden = false;

  const items = state.rawData.items || [];
  const terreName = resolveBestItemMatch("Pomme d'Amour (Terre)", items);
  const serreName = resolveBestItemMatch("Pomme d'Amour (Serre)", items);
  const unsplitName = items.includes("Pomme d'Amour") ? "Pomme d'Amour" : "";

  const terreRecs = terreName ? getItemRecordsInRange(terreName) : [];
  const serreRecs = serreName ? getItemRecordsInRange(serreName) : [];
  const unsplitRecs = unsplitName ? getItemRecordsInRange(unsplitName) : [];

  const summaryGrid = document.getElementById("tomato-summary-grid");
  const chartsStack = document.getElementById("tomato-charts-stack");
  const emptyState = document.getElementById("tomato-empty-state");

  const priceUnitLabel = state.priceUnit === "lb" ? "Rs/lb" : "Rs/kg";
  const isMonthly = state.tomatoGrouping === "month";
  const isPct = state.tomatoVolMode === "pct";

  document.getElementById("tomato-stacked-subtitle").textContent =
    `${isMonthly ? "Regrouped by Month" : "Daily Trading Days"} · ${formatIsoDDMMYY(state.fromIso)} → ${formatIsoDDMMYY(state.toIso)} · ${priceUnitLabel}`;

  if (!terreRecs.length && !serreRecs.length && !unsplitRecs.length) {
    destroyChart("tomatoVolume");
    destroyChart("tomatoPrice");
    summaryGrid.innerHTML = "";
    chartsStack.hidden = true;
    emptyState.hidden = false;
    return;
  }

  chartsStack.hidden = false;
  emptyState.hidden = true;

  // Summary KPI strip across selected range
  const terreVolRecs = terreRecs.filter((r) => r.qty_sold !== null && r.qty_sold !== undefined);
  const serreVolRecs = serreRecs.filter((r) => r.qty_sold !== null && r.qty_sold !== undefined);
  const unsplitVolRecs = unsplitRecs.filter((r) => r.qty_sold !== null && r.qty_sold !== undefined);

  const terreQty = terreVolRecs.reduce((s, r) => s + Number(r.qty_sold), 0);
  const serreQty = serreVolRecs.reduce((s, r) => s + Number(r.qty_sold), 0);
  const unsplitQty = unsplitVolRecs.reduce((s, r) => s + Number(r.qty_sold), 0);
  const splitCombinedQty = terreQty + serreQty;
  const totalCombinedQty = splitCombinedQty + unsplitQty;

  const terreShare = splitCombinedQty > 0 ? (terreQty / splitCombinedQty) * 100 : null;
  const serreShare = splitCombinedQty > 0 ? (serreQty / splitCombinedQty) * 100 : null;

  const terreNormRecs = terreRecs.filter((r) => r.norm_price !== null && r.norm_price !== undefined);
  const serreNormRecs = serreRecs.filter((r) => r.norm_price !== null && r.norm_price !== undefined);
  const terreAvgNorm = terreNormRecs.length
    ? terreNormRecs.reduce((s, r) => s + convertPrice(r.norm_price, r.unit), 0) / terreNormRecs.length
    : null;
  const serreAvgNorm = serreNormRecs.length
    ? serreNormRecs.reduce((s, r) => s + convertPrice(r.norm_price, r.unit), 0) / serreNormRecs.length
    : null;

  // Compute Serre premium on overlapping dates where both have NORM price
  const terreByDate = new Map(terreRecs.map((r) => [r.date_iso, r]));
  const serreByDate = new Map(serreRecs.map((r) => [r.date_iso, r]));
  const unsplitByDate = new Map(unsplitRecs.map((r) => [r.date_iso, r]));

  let premDiffSum = 0;
  let premPctSum = 0;
  let premCount = 0;
  for (const [iso, tRec] of terreByDate.entries()) {
    const sRec = serreByDate.get(iso);
    if (!sRec) continue;
    const tP = convertPrice(tRec.norm_price, tRec.unit);
    const sP = convertPrice(sRec.norm_price, sRec.unit);
    if (tP !== null && sP !== null && tP > 0) {
      premDiffSum += sP - tP;
      premPctSum += ((sP - tP) / tP) * 100;
      premCount += 1;
    }
  }
  const avgPremDiff = premCount ? premDiffSum / premCount : null;
  const avgPremPct = premCount ? premPctSum / premCount : null;

  const allActiveDates = new Set([
    ...terreByDate.keys(),
    ...serreByDate.keys(),
    ...unsplitByDate.keys(),
  ]);

  summaryGrid.innerHTML = `
    <div class="tomato-stat-card tomato-stat-card--total">
      <div class="tomato-stat-label">Combined Volume</div>
      <div class="tomato-stat-value">${formatQty(totalCombinedQty)} <span class="kpi-unit">Kg</span></div>
      <div class="tomato-stat-sub">${allActiveDates.size} trading days${unsplitQty > 0 ? ` (incl. ${formatQty(unsplitQty)} Kg pre-split)` : ""}</div>
    </div>
    <div class="tomato-stat-card tomato-stat-card--terre">
      <div class="tomato-stat-label">Terre (Open Field)</div>
      <div class="tomato-stat-value">${formatQty(terreQty)} <span class="kpi-unit">Kg</span></div>
      <div class="tomato-stat-sub">${terreShare !== null ? `${terreShare.toFixed(1)}% share` : "—"} · Avg NORM: ${terreAvgNorm !== null ? `${formatPrice(terreAvgNorm)} ${priceUnitLabel}` : "—"}</div>
    </div>
    <div class="tomato-stat-card tomato-stat-card--serre">
      <div class="tomato-stat-label">Serre (Greenhouse)</div>
      <div class="tomato-stat-value">${formatQty(serreQty)} <span class="kpi-unit">Kg</span></div>
      <div class="tomato-stat-sub">${serreShare !== null ? `${serreShare.toFixed(1)}% share` : "—"} · Avg NORM: ${serreAvgNorm !== null ? `${formatPrice(serreAvgNorm)} ${priceUnitLabel}` : "—"}</div>
    </div>
    <div class="tomato-stat-card tomato-stat-card--premium">
      <div class="tomato-stat-label">Avg Serre Premium</div>
      <div class="tomato-stat-value">${avgPremDiff !== null ? `${avgPremDiff >= 0 ? "+" : "-"}Rs ${formatPrice(Math.abs(avgPremDiff))}` : "—"}</div>
      <div class="tomato-stat-sub">${avgPremPct !== null ? `${formatSignedPct(avgPremPct)} over Terre (${premCount} shared days)` : "Needs both Terre & Serre in range"}</div>
    </div>`;

  // Build aligned buckets (Daily OR Monthly)
  let labels = [];
  let metaRows = [];
  let includeUnsplit = false;

  if (isMonthly) {
    const aggT = new Map(aggregateRecordsByYearMonth(terreRecs).map((b) => [b.ym, b]));
    const aggS = new Map(aggregateRecordsByYearMonth(serreRecs).map((b) => [b.ym, b]));
    const aggU = new Map(aggregateRecordsByYearMonth(unsplitRecs).map((b) => [b.ym, b]));
    const yms = [...new Set([...aggT.keys(), ...aggS.keys(), ...aggU.keys()])].sort();
    includeUnsplit = aggU.size > 0;

    labels = yms.map((ym) => {
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      return `${MONTH_NAMES[m - 1]} ${String(y % 100).padStart(2, "0")}`;
    });

    metaRows = yms.map((ym) => {
      const t = aggT.get(ym);
      const s = aggS.get(ym);
      const u = aggU.get(ym);
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      const firstIsos = [t?.firstIso, s?.firstIso, u?.firstIso].filter(Boolean).sort();
      const lastIsos = [t?.lastIso, s?.lastIso, u?.lastIso].filter(Boolean).sort();
      return {
        title: `${MONTH_NAMES[m - 1]} ${y} (${formatIsoDDMMYY(firstIsos[0])} – ${formatIsoDDMMYY(lastIsos[lastIsos.length - 1])})`,
        tQty: t && t.qtyCount ? t.totalQty : null,
        sQty: s && s.qtyCount ? s.totalQty : null,
        uQty: u && u.qtyCount ? u.totalQty : null,
        tNorm: t && t.normCount ? t.normSum / t.normCount : null,
        sNorm: s && s.normCount ? s.normSum / s.normCount : null,
        uNorm: u && u.normCount ? u.normSum / u.normCount : null,
        tDays: t?.tradingDays || 0,
        sDays: s?.tradingDays || 0,
      };
    });
  } else {
    const unionDates = [...allActiveDates].sort();
    includeUnsplit = unsplitRecs.length > 0;
    labels = unionDates.map((iso) => formatIsoDDMMYY(iso));
    metaRows = unionDates.map((iso) => {
      const t = terreByDate.get(iso);
      const s = serreByDate.get(iso);
      const u = unsplitByDate.get(iso);
      return {
        title: `Date: ${formatIsoWithWeekday(iso)}`,
        tQty: t && t.qty_sold !== null && t.qty_sold !== undefined ? Number(t.qty_sold) : null,
        sQty: s && s.qty_sold !== null && s.qty_sold !== undefined ? Number(s.qty_sold) : null,
        uQty: u && u.qty_sold !== null && u.qty_sold !== undefined ? Number(u.qty_sold) : null,
        tNorm: t ? convertPrice(t.norm_price, t.unit) : null,
        sNorm: s ? convertPrice(s.norm_price, s.unit) : null,
        uNorm: u ? convertPrice(u.norm_price, u.unit) : null,
        tLow: t ? convertPrice(t.low_price, t.unit) : null,
        tHigh: t ? convertPrice(t.high_price, t.unit) : null,
        sLow: s ? convertPrice(s.low_price, s.unit) : null,
        sHigh: s ? convertPrice(s.high_price, s.unit) : null,
      };
    });
  }

  // Stacked Volume datasets (Kg or 100% Share)
  const volTerreData = metaRows.map((m) => {
    if (!isPct) return m.tQty;
    const sum = (m.tQty || 0) + (m.sQty || 0) + (m.uQty || 0);
    return sum > 0 && m.tQty !== null ? (m.tQty / sum) * 100 : null;
  });
  const volSerreData = metaRows.map((m) => {
    if (!isPct) return m.sQty;
    const sum = (m.tQty || 0) + (m.sQty || 0) + (m.uQty || 0);
    return sum > 0 && m.sQty !== null ? (m.sQty / sum) * 100 : null;
  });
  const volUnsplitData = metaRows.map((m) => {
    if (!isPct) return m.uQty;
    const sum = (m.tQty || 0) + (m.sQty || 0) + (m.uQty || 0);
    return sum > 0 && m.uQty !== null ? (m.uQty / sum) * 100 : null;
  });

  const volDatasets = [
    {
      label: "Pomme d'Amour (Terre)",
      data: volTerreData,
      backgroundColor: "rgba(5, 150, 105, 0.86)",
      borderColor: "#047857",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 40,
      stack: "volume",
    },
    {
      label: "Pomme d'Amour (Serre)",
      data: volSerreData,
      backgroundColor: "rgba(234, 88, 12, 0.86)",
      borderColor: "#c2410c",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 40,
      stack: "volume",
    },
  ];
  if (includeUnsplit) {
    volDatasets.push({
      label: "Pomme d'Amour (Pre-Split Jan–Jul 24)",
      data: volUnsplitData,
      backgroundColor: "rgba(100, 116, 139, 0.78)",
      borderColor: "#475569",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 40,
      stack: "volume",
    });
  }

  document.getElementById("tomato-vol-chart-title").textContent = isPct
    ? `Pomme d'Amour Supply Mix — Stacked Share (Terre + Serre, %)`
    : `Pomme d'Amour ${isMonthly ? "Monthly " : "Daily "}Volume Sold — Stacked (Terre + Serre, Kg)`;

  destroyChart("tomatoVolume");
  const volCtx = document.getElementById("tomato-stacked-volume-chart").getContext("2d");
  state.charts.tomatoVolume = new Chart(volCtx, {
    type: "bar",
    data: { labels, datasets: volDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { size: 12, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, sans-serif", size: 12 },
          padding: 10,
          callbacks: {
            title(items) {
              return metaRows[items[0].dataIndex].title;
            },
            label(c) {
              const m = metaRows[c.dataIndex];
              const sum = (m.tQty || 0) + (m.sQty || 0) + (m.uQty || 0);
              const rawQty = c.datasetIndex === 0 ? m.tQty : c.datasetIndex === 1 ? m.sQty : m.uQty;
              if (rawQty === null || rawQty === undefined) return `${c.dataset.label}: Not recorded`;
              const share = sum > 0 ? ` (${((rawQty / sum) * 100).toFixed(1)}%)` : "";
              return `${c.dataset.label}: ${formatQty(rawQty)} Kg${share}`;
            },
            footer(items) {
              const m = metaRows[items[0].dataIndex];
              const total = (m.tQty || 0) + (m.sQty || 0) + (m.uQty || 0);
              const lines = [];
              if (total > 0) lines.push(`Combined Total: ${formatQty(total)} Kg`);
              if (m.tNorm !== null) lines.push(`Terre NORM: ${formatPrice(m.tNorm)} ${priceUnitLabel}`);
              if (m.sNorm !== null) lines.push(`Serre NORM: ${formatPrice(m.sNorm)} ${priceUnitLabel}`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 18,
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          max: isPct ? 100 : undefined,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: {
            display: true,
            text: isPct ? "Share (%)" : "Kg",
            color: "#4a5d54",
            font: { size: 11, weight: "600" },
          },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
            callback: (v) => (isPct ? `${v}%` : Number(v).toLocaleString("en-US")),
          },
        },
      },
    },
  });

  // NORM Price Chart (Side-by-Side Grouped Bars — never stacked)
  const priceDatasets = [
    {
      label: `Terre NORM (${priceUnitLabel})`,
      data: metaRows.map((m) => m.tNorm),
      backgroundColor: "rgba(5, 150, 105, 0.84)",
      borderColor: "#047857",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 24,
    },
    {
      label: `Serre NORM (${priceUnitLabel})`,
      data: metaRows.map((m) => m.sNorm),
      backgroundColor: "rgba(234, 88, 12, 0.84)",
      borderColor: "#c2410c",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 24,
    },
  ];
  if (includeUnsplit) {
    priceDatasets.push({
      label: `Pre-Split NORM (${priceUnitLabel})`,
      data: metaRows.map((m) => m.uNorm),
      backgroundColor: "rgba(100, 116, 139, 0.78)",
      borderColor: "#475569",
      borderWidth: 1,
      borderRadius: 3,
      maxBarThickness: 24,
    });
  }

  document.getElementById("tomato-price-chart-title").textContent =
    `Pomme d'Amour ${isMonthly ? "Monthly Avg " : ""}NORM Price — Terre vs Serre (${priceUnitLabel})`;

  destroyChart("tomatoPrice");
  const priceCtx = document.getElementById("tomato-stacked-price-chart").getContext("2d");
  state.charts.tomatoPrice = new Chart(priceCtx, {
    type: "bar",
    data: { labels, datasets: priceDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { size: 12, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          titleFont: { family: "JetBrains Mono, monospace", size: 12, weight: "bold" },
          bodyFont: { family: "Inter, sans-serif", size: 12 },
          padding: 10,
          callbacks: {
            title(items) {
              return metaRows[items[0].dataIndex].title;
            },
            label(c) {
              const val = c.raw;
              if (val === null || val === undefined) return `${c.dataset.label}: Not recorded`;
              return `${c.dataset.label}: ${formatPrice(val)} ${priceUnitLabel}`;
            },
            footer(items) {
              const m = metaRows[items[0].dataIndex];
              const lines = [];
              if (m.tNorm !== null && m.sNorm !== null) {
                const diff = m.sNorm - m.tNorm;
                const pct = m.tNorm > 0 ? (diff / m.tNorm) * 100 : null;
                lines.push(
                  `Serre vs Terre: ${diff >= 0 ? "+" : "-"}Rs ${formatPrice(Math.abs(diff))} (${formatSignedPct(pct)})`
                );
              }
              if (!isMonthly && m.tLow !== null && m.tHigh !== null) {
                lines.push(`Terre Low–High: ${formatPrice(m.tLow)} – ${formatPrice(m.tHigh)} ${priceUnitLabel}`);
              }
              if (!isMonthly && m.sLow !== null && m.sHigh !== null) {
                lines.push(`Serre Low–High: ${formatPrice(m.sLow)} – ${formatPrice(m.sHigh)} ${priceUnitLabel}`);
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 18,
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: {
            display: true,
            text: priceUnitLabel,
            color: "#4a5d54",
            font: { size: 11, weight: "600" },
          },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Date-to-Date Comparison (e.g., 16/11/25 vs 16/11/26)
// ---------------------------------------------------------------------------

function findAdjacentTradingDates(targetIso) {
  const dates = state.sortedTradingDates;
  if (!dates.length || !targetIso) return { prev: null, next: null };
  let lo = 0;
  let hi = dates.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] === targetIso) {
      return {
        prev: mid > 0 ? dates[mid - 1] : null,
        next: mid + 1 < dates.length ? dates[mid + 1] : null,
      };
    }
    if (dates[mid] < targetIso) lo = mid + 1;
    else hi = mid - 1;
  }
  return {
    prev: hi >= 0 ? dates[hi] : null,
    next: lo < dates.length ? dates[lo] : null,
  };
}

function findNearestTradingDate(targetIso) {
  if (!targetIso) return "";
  if (state.recordsByDate.has(targetIso)) return targetIso;
  const { prev, next } = findAdjacentTradingDates(targetIso);
  if (prev && next) {
    const dPrev = Math.abs(daysBetweenIso(prev, targetIso));
    const dNext = Math.abs(daysBetweenIso(targetIso, next));
    return dPrev <= dNext ? prev : next;
  }
  return prev || next || "";
}

function syncD2DInputsUI() {
  const dispA = document.getElementById("d2d-date-a-display");
  const dispB = document.getElementById("d2d-date-b-display");
  const natA = document.getElementById("d2d-date-a-native");
  const natB = document.getElementById("d2d-date-b-native");
  const errEl = document.getElementById("d2d-error");

  dispA.value = formatIsoDDMMYY(state.d2dDateA);
  dispB.value = formatIsoDDMMYY(state.d2dDateB);
  natA.value = state.d2dDateA;
  natB.value = state.d2dDateB;
  if (state.rawData?.date_range) {
    natA.min = state.rawData.date_range.min_iso || "";
    natA.max = state.rawData.date_range.max_iso || "";
    natB.min = state.rawData.date_range.min_iso || "";
    natB.max = state.rawData.date_range.max_iso || "";
  }
  errEl.hidden = true;
  errEl.textContent = "";
}

function setD2DDates(isoA, isoB) {
  const errEl = document.getElementById("d2d-error");
  if (!isoA || !isoB) {
    errEl.textContent = "Please enter valid dates in dd/mm/yy format (e.g. 16/11/25 and 16/11/26).";
    errEl.hidden = false;
    return;
  }
  state.d2dDateA = isoA;
  state.d2dDateB = isoB;
  syncD2DInputsUI();
  renderDateToDateComparison();
}

function populateMonthSelects() {
  const selA = document.getElementById("d2d-month-a-select");
  const selB = document.getElementById("d2d-month-b-select");
  const monthsDesc = [...state.sortedYearMonths].reverse();

  const buildOptions = (sel) => {
    sel.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const ym of monthsDesc) {
      const ymMap = state.recordsByYearMonth.get(ym);
      const uniqueDays = new Set();
      if (ymMap) {
        for (const list of ymMap.values()) {
          for (const r of list) uniqueDays.add(r.date_iso);
        }
      }
      const opt = document.createElement("option");
      opt.value = ym;
      opt.textContent = `${formatYearMonthLong(ym)} (${uniqueDays.size}d)`;
      frag.appendChild(opt);
    }
    sel.appendChild(frag);
  };

  buildOptions(selA);
  buildOptions(selB);
  if (state.d2dMonthA) selA.value = state.d2dMonthA;
  if (state.d2dMonthB) selB.value = state.d2dMonthB;
}

function syncD2DModeUI() {
  const isMonth = state.d2dMode === "month";
  document.getElementById("d2d-date-pickers").hidden = isMonth;
  document.getElementById("d2d-month-pickers").hidden = !isMonth;

  document.getElementById("btn-d2d-yoy1").textContent = isMonth ? "Same Month Last Year" : "Same Day Last Year";
  document.getElementById("btn-d2d-yoy2").textContent = isMonth ? "Same Month 2 Yrs Ago" : "Same Day 2 Yrs Ago";
  document.getElementById("btn-d2d-prev").textContent = isMonth ? "Previous Month" : "Prev Trading Day";

  document.getElementById("d2d-table-heading-text").textContent = isMonth
    ? "All Market Items Across Both Months"
    : "All Market Items on Both Dates";
  document.getElementById("d2d-both-only-label").textContent = isMonth
    ? "Traded in both months only"
    : "Traded on both dates only";
  document.getElementById("d2d-sort-vol-opt").textContent = isMonth
    ? "Highest Month B Volume"
    : "Highest Date B Volume";
}

function summarizeMonthRecords(recs, fallbackUnit = "") {
  if (!recs || !recs.length) return null;
  let normSum = 0;
  let normCount = 0;
  let lowSum = 0;
  let lowCount = 0;
  let highSum = 0;
  let highCount = 0;
  let totalQty = 0;
  let qtyCount = 0;
  let unit = fallbackUnit;
  let firstIso = recs[0].date_iso;
  let lastIso = recs[0].date_iso;

  for (const r of recs) {
    if (r.date_iso < firstIso) firstIso = r.date_iso;
    if (r.date_iso > lastIso) lastIso = r.date_iso;
    if (r.unit) unit = r.unit;
    const norm = convertPrice(r.norm_price, r.unit);
    if (norm !== null) {
      normSum += norm;
      normCount += 1;
    }
    const low = convertPrice(r.low_price, r.unit);
    if (low !== null) {
      lowSum += low;
      lowCount += 1;
    }
    const high = convertPrice(r.high_price, r.unit);
    if (high !== null) {
      highSum += high;
      highCount += 1;
    }
    if (r.qty_sold !== null && r.qty_sold !== undefined) {
      totalQty += Number(r.qty_sold);
      qtyCount += 1;
    }
  }

  return {
    unit,
    pLabel: getPriceUnitLabel(unit),
    qLabel: unit || "Units",
    avgNorm: normCount ? normSum / normCount : null,
    avgLow: lowCount ? lowSum / lowCount : null,
    avgHigh: highCount ? highSum / highCount : null,
    totalQty: qtyCount ? totalQty : null,
    avgDailyQty: qtyCount ? totalQty / qtyCount : null,
    tradingDays: recs.length,
    firstIso,
    lastIso,
  };
}

function renderPriceTrendCell(td, pDiff, pPct) {
  if (pDiff === null) {
    td.textContent = "—";
    return;
  }
  if (Math.abs(pDiff) < 1e-6) {
    td.textContent = "→ 0%";
    return;
  }
  const cls = pDiff > 0 ? "delta-up" : "delta-down";
  const arrow = pDiff > 0 ? "▲" : "▼";
  const sign = pDiff > 0 ? "+" : "-";
  td.innerHTML = `<span class="${cls}">${arrow} ${sign}${formatPrice(Math.abs(pDiff))} (${formatSignedPct(pPct)})</span>`;
}

function renderMonthToMonthComparison() {
  if (!state.rawData || !state.d2dMonthA || !state.d2dMonthB) return;

  const ymA = state.d2dMonthA;
  const ymB = state.d2dMonthB;
  const dispAShort = formatYearMonthShort(ymA);
  const dispBShort = formatYearMonthShort(ymB);
  const dispALong = formatYearMonthLong(ymA);
  const dispBLong = formatYearMonthLong(ymB);

  const mapA = state.recordsByYearMonth.get(ymA) || null;
  const mapB = state.recordsByYearMonth.get(ymB) || null;

  document.getElementById("d2d-closed-notice").hidden = true;
  document.getElementById("d2d-closed-notice").innerHTML = "";
  document.getElementById("d2d-error").hidden = true;

  document.getElementById("date-compare-subtitle").textContent =
    `${state.selectedItem} & all NWM commodities · Monthly Averages: ${dispALong} vs ${dispBLong}`;

  const item = state.selectedItem;
  const fallbackUnit = state.itemLatestUnit.get(item) || "";
  const sumA = summarizeMonthRecords(mapA?.get(item), fallbackUnit);
  const sumB = summarizeMonthRecords(mapB?.get(item), fallbackUnit);

  const pLabelA = sumA?.pLabel || getPriceUnitLabel(fallbackUnit);
  const pLabelB = sumB?.pLabel || getPriceUnitLabel(fallbackUnit);
  const qLabelA = sumA?.qLabel || fallbackUnit || "Units";
  const qLabelB = sumB?.qLabel || fallbackUnit || "Units";

  const normA = sumA ? sumA.avgNorm : null;
  const normB = sumB ? sumB.avgNorm : null;
  const lowA = sumA ? sumA.avgLow : null;
  const lowB = sumB ? sumB.avgLow : null;
  const highA = sumA ? sumA.avgHigh : null;
  const highB = sumB ? sumB.avgHigh : null;
  const qtyA = sumA ? sumA.totalQty : null;
  const qtyB = sumB ? sumB.totalQty : null;
  const dailyQtyA = sumA ? sumA.avgDailyQty : null;
  const dailyQtyB = sumB ? sumB.avgDailyQty : null;

  const priceDiff = normA !== null && normB !== null ? normB - normA : null;
  const pricePct = priceDiff !== null && normA > 0 ? (priceDiff / normA) * 100 : null;
  const qtyDiff = qtyA !== null && qtyB !== null ? qtyB - qtyA : null;
  const qtyPct = qtyDiff !== null && qtyA > 0 ? (qtyDiff / qtyA) * 100 : null;
  const dailyQtyPct =
    dailyQtyA !== null && dailyQtyB !== null && dailyQtyA > 0
      ? ((dailyQtyB - dailyQtyA) / dailyQtyA) * 100
      : null;

  const renderMonthCard = (slotLabel, cls, dispLong, sum, pLabel, qLabel) => {
    const spanText = sum
      ? `${sum.tradingDays}d · ${formatIsoDDMMYY(sum.firstIso)} – ${formatIsoDDMMYY(sum.lastIso)}`
      : "No records";
    const spreadText = sum
      ? `Avg Low–High: ${formatPrice(sum.avgLow)} – ${formatPrice(sum.avgHigh)} ${pLabel}`
      : "Not traded / unrecorded";
    const volSub = sum && sum.avgDailyQty !== null
      ? `Daily avg: ${formatQty(sum.avgDailyQty)} ${qLabel} (${spanText})`
      : spanText;
    return `
      <div class="d2d-card ${cls}">
        <div class="d2d-card-head">
          <span class="compare-tag ${slotLabel === "Month A" ? "compare-tag--a" : "compare-tag--b"}">${slotLabel}</span>
          <span class="d2d-card-date">${escapeHtml(dispLong)}</span>
        </div>
        <div class="d2d-card-metrics">
          <div>
            <div class="d2d-metric-label">Avg NORM Price</div>
            <div class="d2d-metric-val">${sum && sum.avgNorm !== null ? `${formatPrice(sum.avgNorm)} <span class="kpi-unit">${escapeHtml(pLabel)}</span>` : "—"}</div>
            <div class="d2d-metric-sub">${escapeHtml(spreadText)}</div>
          </div>
          <div>
            <div class="d2d-metric-label">Total Volume Sold</div>
            <div class="d2d-metric-val">${sum && sum.totalQty !== null ? `${formatQty(sum.totalQty)} <span class="kpi-unit">${escapeHtml(qLabel)}</span>` : "—"}</div>
            <div class="d2d-metric-sub">${escapeHtml(volSub)}</div>
          </div>
        </div>
      </div>`;
  };

  let priceDeltaHtml = "—";
  let priceDeltaSub = "Needs Avg NORM in both months";
  if (priceDiff !== null) {
    if (Math.abs(priceDiff) < 1e-6) {
      priceDeltaHtml = "0.00";
      priceDeltaSub = "Unchanged";
    } else {
      const cls = priceDiff > 0 ? "delta-up" : "delta-down";
      const sign = priceDiff > 0 ? "+" : "-";
      priceDeltaHtml = `<span class="${cls}">${sign}Rs ${formatPrice(Math.abs(priceDiff))}</span>`;
      priceDeltaSub = `<span class="${cls}">${formatSignedPct(pricePct)}</span> avg NORM (${pLabelB})`;
    }
  }

  let qtyDeltaHtml = "—";
  let qtyDeltaSub = "Needs volume in both months";
  if (qtyDiff !== null) {
    if (Math.abs(qtyDiff) < 1e-6) {
      qtyDeltaHtml = "0";
      qtyDeltaSub = "Unchanged";
    } else {
      const cls = qtyPct !== null && qtyPct < -30 ? "delta-drop" : qtyDiff > 0 ? "delta-down" : "delta-up";
      const sign = qtyDiff > 0 ? "+" : "-";
      qtyDeltaHtml = `<span class="${cls}">${sign}${formatQty(Math.abs(qtyDiff))}</span>`;
      qtyDeltaSub =
        `<span class="${cls}">${formatSignedPct(qtyPct)}</span> total` +
        (dailyQtyPct !== null ? ` · Daily avg: ${formatSignedPct(dailyQtyPct)}` : "");
    }
  }

  document.getElementById("d2d-spotlight-grid").innerHTML =
    renderMonthCard("Month A", "d2d-card--a", dispALong, sumA, pLabelA, qLabelA) +
    renderMonthCard("Month B", "d2d-card--b", dispBLong, sumB, pLabelB, qLabelB) +
    `
      <div class="d2d-card d2d-card--delta">
        <div class="d2d-card-head">
          <span class="kpi-label">Change (A → B)</span>
          <span class="kpi-date-chip">${escapeHtml(dispAShort)} → ${escapeHtml(dispBShort)}</span>
        </div>
        <div class="d2d-card-metrics">
          <div>
            <div class="d2d-metric-label">Avg Price Δ</div>
            <div class="d2d-metric-val">${priceDeltaHtml}</div>
            <div class="d2d-metric-sub">${priceDeltaSub}</div>
          </div>
          <div>
            <div class="d2d-metric-label">Total Volume Δ</div>
            <div class="d2d-metric-val">${qtyDeltaHtml}</div>
            <div class="d2d-metric-sub">${qtyDeltaSub}</div>
          </div>
        </div>
      </div>`;

  // Snapshot charts for Month A vs Month B
  const priceTitleUnit = pLabelA === pLabelB ? pLabelA : `${pLabelA} / ${pLabelB}`;
  const qtyTitleUnit = qLabelA === qLabelB ? qLabelA : `${qLabelA} / ${qLabelB}`;
  document.getElementById("d2d-price-chart-title").textContent =
    `${item} — Monthly Average Price: Avg Low / Avg NORM / Avg High (${priceTitleUnit})`;
  document.getElementById("d2d-volume-chart-title").textContent =
    `${item} — Monthly Total Volume Sold (${qtyTitleUnit})`;

  destroyChart("d2dPrice");
  const d2dPriceCtx = document.getElementById("d2d-price-chart").getContext("2d");
  state.charts.d2dPrice = new Chart(d2dPriceCtx, {
    type: "bar",
    data: {
      labels: ["Avg Low Price", "Avg NORM Price", "Avg High Price"],
      datasets: [
        {
          label: dispALong,
          data: [lowA, normA, highA],
          backgroundColor: "rgba(5, 150, 105, 0.84)",
          borderColor: "#047857",
          borderWidth: 1,
          borderRadius: 5,
          maxBarThickness: 44,
        },
        {
          label: dispBLong,
          data: [lowB, normB, highB],
          backgroundColor: "rgba(217, 119, 6, 0.84)",
          borderColor: "#b45309",
          borderWidth: 1,
          borderRadius: 5,
          maxBarThickness: 44,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { family: "JetBrains Mono, monospace", size: 11, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            label(c) {
              const u = c.datasetIndex === 0 ? pLabelA : pLabelB;
              return c.raw === null || c.raw === undefined
                ? `${c.dataset.label}: No data`
                : `${c.dataset.label}: ${formatPrice(c.raw)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11, weight: "600" }, color: "#4a5d54" } },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: priceTitleUnit, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: { font: { family: "JetBrains Mono, monospace", size: 11 }, color: "#4a5d54" },
        },
      },
    },
  });

  destroyChart("d2dVolume");
  const d2dVolCtx = document.getElementById("d2d-volume-chart").getContext("2d");
  state.charts.d2dVolume = new Chart(d2dVolCtx, {
    type: "bar",
    data: {
      labels: [dispALong, dispBLong],
      datasets: [
        {
          label: `Total Volume Sold (${qtyTitleUnit})`,
          data: [qtyA, qtyB],
          backgroundColor: ["rgba(5, 150, 105, 0.84)", "rgba(217, 119, 6, 0.84)"],
          borderColor: ["#047857", "#b45309"],
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 64,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            label(c) {
              const s = c.dataIndex === 0 ? sumA : sumB;
              const u = c.dataIndex === 0 ? qLabelA : qLabelB;
              if (!s || s.totalQty === null) return "No volume recorded";
              return `Total Volume: ${formatQty(s.totalQty)} ${u}`;
            },
            afterLabel(c) {
              const s = c.dataIndex === 0 ? sumA : sumB;
              const u = c.dataIndex === 0 ? qLabelA : qLabelB;
              if (!s) return [];
              const lines = [];
              if (s.avgDailyQty !== null) lines.push(`Daily Avg: ${formatQty(s.avgDailyQty)} ${u}`);
              lines.push(`Trading Days: ${s.tradingDays} (${formatIsoDDMMYY(s.firstIso)} – ${formatIsoDDMMYY(s.lastIso)})`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "JetBrains Mono, monospace", size: 11, weight: "600" }, color: "#4a5d54" } },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: qtyTitleUnit, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
            callback: (v) => Number(v).toLocaleString("en-US"),
          },
        },
      },
    },
  });

  // All-Market Monthly Comparison Table
  document.getElementById("d2d-col-pa").textContent = `${dispAShort} Avg Price`;
  document.getElementById("d2d-col-pb").textContent = `${dispBShort} Avg Price`;
  document.getElementById("d2d-col-qa").textContent = `${dispAShort} Total Qty`;
  document.getElementById("d2d-col-qb").textContent = `${dispBShort} Total Qty`;

  const tableEl = document.getElementById("d2d-table");
  tableEl.style.setProperty("--label-2", `"${dispAShort} Avg Price"`);
  tableEl.style.setProperty("--label-3", `"${dispBShort} Avg Price"`);
  tableEl.style.setProperty("--label-4", `"Avg Price Trend"`);
  tableEl.style.setProperty("--label-5", `"${dispAShort} Total Qty"`);
  tableEl.style.setProperty("--label-6", `"${dispBShort} Total Qty"`);
  tableEl.style.setProperty("--label-7", `"Qty Δ"`);

  const itemNames = new Set();
  if (mapA) for (const k of mapA.keys()) itemNames.add(k);
  if (mapB) for (const k of mapB.keys()) itemNames.add(k);

  const query = normalizeSearchKey(state.d2dSearch);
  const rows = [];
  for (const name of itemNames) {
    if (query && !normalizeSearchKey(name).includes(query)) continue;
    const sA = summarizeMonthRecords(mapA?.get(name), state.itemLatestUnit.get(name) || "");
    const sB = summarizeMonthRecords(mapB?.get(name), state.itemLatestUnit.get(name) || "");
    if (state.d2dBothOnly && (!sA || !sB)) continue;

    const u = sB?.unit || sA?.unit || state.itemLatestUnit.get(name) || "";
    const pA = sA ? sA.avgNorm : null;
    const pB = sB ? sB.avgNorm : null;
    const qA = sA ? sA.totalQty : null;
    const qB = sB ? sB.totalQty : null;
    const pPct = pA !== null && pB !== null && pA > 0 ? ((pB - pA) / pA) * 100 : null;
    const qPct = qA !== null && qB !== null && qA > 0 ? ((qB - qA) / qA) * 100 : null;

    rows.push({
      name,
      pLabel: getPriceUnitLabel(u),
      pA,
      pB,
      pDiff: pA !== null && pB !== null ? pB - pA : null,
      pPct,
      qA,
      qB,
      qDiff: qA !== null && qB !== null ? qB - qA : null,
      qPct,
    });
  }

  if (state.d2dSort === "price-up") {
    rows.sort((a, b) => (b.pPct ?? -Infinity) - (a.pPct ?? -Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "price-down") {
    rows.sort((a, b) => (a.pPct ?? Infinity) - (b.pPct ?? Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "vol-drop") {
    rows.sort((a, b) => (a.qPct ?? Infinity) - (b.qPct ?? Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "vol-high") {
    rows.sort((a, b) => (b.qB ?? -Infinity) - (a.qB ?? -Infinity) || a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  document.getElementById("d2d-table-count").textContent = `${rows.length} ${rows.length === 1 ? "item" : "items"}`;

  const tbody = document.getElementById("d2d-table-body");
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.style.textAlign = "center";
    td.style.color = "#6f8178";
    td.style.padding = "20px";
    td.textContent = "No monthly market records match these months and filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.name === state.selectedItem) tr.classList.add("is-selected-item");
    tr.title = `Click to view ${r.name} across all dashboard charts`;
    tr.addEventListener("click", () => selectPrimaryItem(r.name));

    const th = document.createElement("th");
    th.scope = "row";
    th.innerHTML = `${escapeHtml(r.name)}<span class="item-unit-chip">${escapeHtml(r.pLabel)}</span>`;

    const tdPa = document.createElement("td");
    tdPa.className = "num";
    tdPa.textContent = r.pA !== null ? formatPrice(r.pA) : "—";

    const tdPb = document.createElement("td");
    tdPb.className = "num norm-cell";
    tdPb.textContent = r.pB !== null ? formatPrice(r.pB) : "—";

    const tdPd = document.createElement("td");
    tdPd.className = "num";
    renderPriceTrendCell(tdPd, r.pDiff, r.pPct);

    const tdQa = document.createElement("td");
    tdQa.className = "num";
    tdQa.textContent = r.qA !== null ? formatQty(r.qA) : "—";

    const tdQb = document.createElement("td");
    tdQb.className = "num";
    tdQb.textContent = r.qB !== null ? formatQty(r.qB) : "—";

    const tdQd = document.createElement("td");
    tdQd.className = "num";
    if (r.qDiff !== null) {
      if (Math.abs(r.qDiff) < 1e-6) {
        tdQd.textContent = "→ 0%";
      } else {
        const cls = r.qPct !== null && r.qPct < -30 ? "delta-drop" : r.qDiff > 0 ? "delta-down" : "delta-up";
        tdQd.innerHTML = `<span class="${cls}">${formatSignedPct(r.qPct)}</span>`;
      }
    } else {
      tdQd.textContent = "—";
    }

    tr.append(th, tdPa, tdPb, tdPd, tdQa, tdQb, tdQd);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function setD2DMonths(ymA, ymB) {
  const errEl = document.getElementById("d2d-error");
  if (!state.recordsByYearMonth.has(ymA) || !state.recordsByYearMonth.has(ymB)) {
    const missing = !state.recordsByYearMonth.has(ymA) ? formatYearMonthLong(ymA) : formatYearMonthLong(ymB);
    errEl.textContent = `No NWM data available for ${missing}. Available months span ${formatYearMonthLong(state.sortedYearMonths[0])} – ${formatYearMonthLong(state.sortedYearMonths[state.sortedYearMonths.length - 1])}.`;
    errEl.hidden = false;
    return;
  }
  state.d2dMonthA = ymA;
  state.d2dMonthB = ymB;
  document.getElementById("d2d-month-a-select").value = ymA;
  document.getElementById("d2d-month-b-select").value = ymB;
  errEl.hidden = true;
  renderMonthToMonthComparison();
}

function renderDateToDateComparison() {
  if (state.d2dMode === "month") {
    renderMonthToMonthComparison();
    return;
  }
  if (!state.rawData || !state.d2dDateA || !state.d2dDateB) return;

  const isoA = state.d2dDateA;
  const isoB = state.d2dDateB;
  const dispA = formatIsoDDMMYY(isoA);
  const dispB = formatIsoDDMMYY(isoB);
  const dispAFull = formatIsoWithWeekday(isoA);
  const dispBFull = formatIsoWithWeekday(isoB);

  const mapA = state.recordsByDate.get(isoA) || null;
  const mapB = state.recordsByDate.get(isoB) || null;

  document.getElementById("date-compare-subtitle").textContent =
    `${state.selectedItem} & all NWM commodities · ${dispAFull} vs ${dispBFull}`;

  // Closed-day helper notice (zero extrapolation: never substitute silently)
  const closedNotice = document.getElementById("d2d-closed-notice");
  const closedRows = [];
  for (const [slot, iso, map] of [
    ["A", isoA, mapA],
    ["B", isoB, mapB],
  ]) {
    if (!map) {
      const { prev, next } = findAdjacentTradingDates(iso);
      const btns = [];
      if (prev) {
        const diffPrev = daysBetweenIso(prev, iso);
        btns.push(
          `<button type="button" class="d2d-nearest-btn" data-slot="${slot}" data-iso="${prev}">Use ${formatIsoWithWeekday(prev)} (-${diffPrev}d)</button>`
        );
      }
      if (next) {
        const diffNext = daysBetweenIso(iso, next);
        btns.push(
          `<button type="button" class="d2d-nearest-btn" data-slot="${slot}" data-iso="${next}">Use ${formatIsoWithWeekday(next)} (+${diffNext}d)</button>`
        );
      }
      closedRows.push(
        `<div class="d2d-closed-row">` +
          `<span><strong>Date ${slot} (${formatIsoWithWeekday(iso)}):</strong> Market closed / no AMB bulletin published (no values extrapolated).</span>` +
          (btns.length ? `<span>Switch Date ${slot} to nearest trading day:</span>${btns.join("")}` : "") +
        `</div>`
      );
    }
  }
  if (closedRows.length) {
    closedNotice.innerHTML = closedRows.join("");
    closedNotice.hidden = false;
    closedNotice.querySelectorAll(".d2d-nearest-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slot = btn.dataset.slot;
        const nextIso = btn.dataset.iso;
        if (slot === "A") setD2DDates(nextIso, state.d2dDateB);
        else setD2DDates(state.d2dDateA, nextIso);
      });
    });
  } else {
    closedNotice.hidden = true;
    closedNotice.innerHTML = "";
  }

  // Spotlight for currently selected commodity
  const item = state.selectedItem;
  const recA = mapA?.get(item) || null;
  const recB = mapB?.get(item) || null;
  const fallbackUnit = state.itemLatestUnit.get(item) || "";
  const unitA = recA?.unit || fallbackUnit;
  const unitB = recB?.unit || fallbackUnit;
  const pLabelA = getPriceUnitLabel(unitA);
  const pLabelB = getPriceUnitLabel(unitB);
  const qLabelA = unitA || "Units";
  const qLabelB = unitB || "Units";

  const normA = recA ? convertPrice(recA.norm_price, recA.unit) : null;
  const normB = recB ? convertPrice(recB.norm_price, recB.unit) : null;
  const lowA = recA ? convertPrice(recA.low_price, recA.unit) : null;
  const lowB = recB ? convertPrice(recB.low_price, recB.unit) : null;
  const highA = recA ? convertPrice(recA.high_price, recA.unit) : null;
  const highB = recB ? convertPrice(recB.high_price, recB.unit) : null;
  const qtyA = recA && recA.qty_sold !== null && recA.qty_sold !== undefined ? Number(recA.qty_sold) : null;
  const qtyB = recB && recB.qty_sold !== null && recB.qty_sold !== undefined ? Number(recB.qty_sold) : null;

  const priceDiff = normA !== null && normB !== null ? normB - normA : null;
  const pricePct = priceDiff !== null && normA > 0 ? (priceDiff / normA) * 100 : null;
  const qtyDiff = qtyA !== null && qtyB !== null ? qtyB - qtyA : null;
  const qtyPct = qtyDiff !== null && qtyA > 0 ? (qtyDiff / qtyA) * 100 : null;

  const renderDateCard = (slotLabel, cls, dispFull, rec, mapExists, norm, low, high, qty, pLabel, qLabel) => {
    const statusNote = !mapExists
      ? "Market closed"
      : !rec
        ? "Not traded / unrecorded"
        : `Low–High: ${formatPrice(low)} – ${formatPrice(high)} ${pLabel}`;
    return `
      <div class="d2d-card ${cls}">
        <div class="d2d-card-head">
          <span class="compare-tag ${slotLabel === "Date A" ? "compare-tag--a" : "compare-tag--b"}">${slotLabel}</span>
          <span class="d2d-card-date">${escapeHtml(dispFull)}</span>
        </div>
        <div class="d2d-card-metrics">
          <div>
            <div class="d2d-metric-label">NORM Price</div>
            <div class="d2d-metric-val">${norm !== null ? `${formatPrice(norm)} <span class="kpi-unit">${escapeHtml(pLabel)}</span>` : "—"}</div>
            <div class="d2d-metric-sub">${escapeHtml(statusNote)}</div>
          </div>
          <div>
            <div class="d2d-metric-label">Volume Sold</div>
            <div class="d2d-metric-val">${qty !== null ? `${formatQty(qty)} <span class="kpi-unit">${escapeHtml(qLabel)}</span>` : "—"}</div>
            <div class="d2d-metric-sub">${escapeHtml(item)}</div>
          </div>
        </div>
      </div>`;
  };

  let priceDeltaHtml = "—";
  let priceDeltaSub = "Needs NORM price on both dates";
  if (priceDiff !== null) {
    if (Math.abs(priceDiff) < 1e-6) {
      priceDeltaHtml = `0.00`;
      priceDeltaSub = "Unchanged";
    } else {
      const cls = priceDiff > 0 ? "delta-up" : "delta-down";
      const sign = priceDiff > 0 ? "+" : "-";
      priceDeltaHtml = `<span class="${cls}">${sign}Rs ${formatPrice(Math.abs(priceDiff))}</span>`;
      priceDeltaSub = `<span class="${cls}">${formatSignedPct(pricePct)}</span> (${pLabelB})`;
    }
  }

  let qtyDeltaHtml = "—";
  let qtyDeltaSub = "Needs volume on both dates";
  if (qtyDiff !== null) {
    if (Math.abs(qtyDiff) < 1e-6) {
      qtyDeltaHtml = "0";
      qtyDeltaSub = "Unchanged";
    } else {
      const cls = qtyPct !== null && qtyPct < -30 ? "delta-drop" : qtyDiff > 0 ? "delta-down" : "delta-up";
      const sign = qtyDiff > 0 ? "+" : "-";
      qtyDeltaHtml = `<span class="${cls}">${sign}${formatQty(Math.abs(qtyDiff))}</span>`;
      qtyDeltaSub = `<span class="${cls}">${formatSignedPct(qtyPct)}</span> (${qLabelB})`;
    }
  }

  document.getElementById("d2d-spotlight-grid").innerHTML =
    renderDateCard("Date A", "d2d-card--a", dispAFull, recA, Boolean(mapA), normA, lowA, highA, qtyA, pLabelA, qLabelA) +
    renderDateCard("Date B", "d2d-card--b", dispBFull, recB, Boolean(mapB), normB, lowB, highB, qtyB, pLabelB, qLabelB) +
    `
      <div class="d2d-card d2d-card--delta">
        <div class="d2d-card-head">
          <span class="kpi-label">Change (A → B)</span>
          <span class="kpi-date-chip">${escapeHtml(dispA)} → ${escapeHtml(dispB)}</span>
        </div>
        <div class="d2d-card-metrics">
          <div>
            <div class="d2d-metric-label">NORM Price Δ</div>
            <div class="d2d-metric-val">${priceDeltaHtml}</div>
            <div class="d2d-metric-sub">${priceDeltaSub}</div>
          </div>
          <div>
            <div class="d2d-metric-label">Volume Δ</div>
            <div class="d2d-metric-val">${qtyDeltaHtml}</div>
            <div class="d2d-metric-sub">${qtyDeltaSub}</div>
          </div>
        </div>
      </div>`;

  // Snapshot charts for selected item
  const priceTitleUnit = pLabelA === pLabelB ? pLabelA : `${pLabelA} / ${pLabelB}`;
  const qtyTitleUnit = qLabelA === qLabelB ? qLabelA : `${qLabelA} / ${qLabelB}`;
  document.getElementById("d2d-price-chart-title").textContent =
    `${item} — Low / NORM / High Price (${priceTitleUnit})`;
  document.getElementById("d2d-volume-chart-title").textContent =
    `${item} — Volume Sold (${qtyTitleUnit})`;

  destroyChart("d2dPrice");
  const d2dPriceCtx = document.getElementById("d2d-price-chart").getContext("2d");
  state.charts.d2dPrice = new Chart(d2dPriceCtx, {
    type: "bar",
    data: {
      labels: ["Low Price", "Most Common (NORM)", "High Price"],
      datasets: [
        {
          label: dispAFull,
          data: [lowA, normA, highA],
          backgroundColor: "rgba(5, 150, 105, 0.84)",
          borderColor: "#047857",
          borderWidth: 1,
          borderRadius: 5,
          maxBarThickness: 44,
        },
        {
          label: dispBFull,
          data: [lowB, normB, highB],
          backgroundColor: "rgba(217, 119, 6, 0.84)",
          borderColor: "#b45309",
          borderWidth: 1,
          borderRadius: 5,
          maxBarThickness: 44,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true, pointStyle: "rectRounded", font: { family: "JetBrains Mono, monospace", size: 11, weight: "600" } },
        },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            label(c) {
              const u = c.datasetIndex === 0 ? pLabelA : pLabelB;
              return c.raw === null || c.raw === undefined
                ? `${c.dataset.label}: No data`
                : `${c.dataset.label}: ${formatPrice(c.raw)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11, weight: "600" }, color: "#4a5d54" } },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: priceTitleUnit, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: { font: { family: "JetBrains Mono, monospace", size: 11 }, color: "#4a5d54" },
        },
      },
    },
  });

  destroyChart("d2dVolume");
  const d2dVolCtx = document.getElementById("d2d-volume-chart").getContext("2d");
  state.charts.d2dVolume = new Chart(d2dVolCtx, {
    type: "bar",
    data: {
      labels: [dispAFull, dispBFull],
      datasets: [
        {
          label: `Volume Sold (${qtyTitleUnit})`,
          data: [qtyA, qtyB],
          backgroundColor: ["rgba(5, 150, 105, 0.84)", "rgba(217, 119, 6, 0.84)"],
          borderColor: ["#047857", "#b45309"],
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 64,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b291f",
          padding: 10,
          callbacks: {
            label(c) {
              const u = c.dataIndex === 0 ? qLabelA : qLabelB;
              return c.raw === null || c.raw === undefined
                ? "No volume recorded"
                : `Volume Sold: ${formatQty(c.raw)} ${u}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "JetBrains Mono, monospace", size: 11, weight: "600" }, color: "#4a5d54" } },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(197, 208, 199, 0.45)" },
          title: { display: true, text: qtyTitleUnit, color: "#4a5d54", font: { size: 11, weight: "600" } },
          ticks: {
            font: { family: "JetBrains Mono, monospace", size: 11 },
            color: "#4a5d54",
            callback: (v) => Number(v).toLocaleString("en-US"),
          },
        },
      },
    },
  });

  // All-Market Table Headers & CSS responsive labels with exact dd/mm/yy dates
  document.getElementById("d2d-col-pa").textContent = `${dispA} NORM`;
  document.getElementById("d2d-col-pb").textContent = `${dispB} NORM`;
  document.getElementById("d2d-col-qa").textContent = `${dispA} Qty`;
  document.getElementById("d2d-col-qb").textContent = `${dispB} Qty`;

  const tableEl = document.getElementById("d2d-table");
  tableEl.style.setProperty("--label-2", `"${dispA} NORM"`);
  tableEl.style.setProperty("--label-3", `"${dispB} NORM"`);
  tableEl.style.setProperty("--label-4", `"Price Trend"`);
  tableEl.style.setProperty("--label-5", `"${dispA} Qty"`);
  tableEl.style.setProperty("--label-6", `"${dispB} Qty"`);
  tableEl.style.setProperty("--label-7", `"Qty Δ"`);

  // Build union of items across Date A and Date B
  const itemNames = new Set();
  if (mapA) for (const k of mapA.keys()) itemNames.add(k);
  if (mapB) for (const k of mapB.keys()) itemNames.add(k);

  const query = normalizeSearchKey(state.d2dSearch);
  const rows = [];
  for (const name of itemNames) {
    if (query && !normalizeSearchKey(name).includes(query)) continue;
    const rA = mapA?.get(name) || null;
    const rB = mapB?.get(name) || null;
    if (state.d2dBothOnly && (!rA || !rB)) continue;

    const u = rB?.unit || rA?.unit || state.itemLatestUnit.get(name) || "";
    const pA = rA ? convertPrice(rA.norm_price, rA.unit) : null;
    const pB = rB ? convertPrice(rB.norm_price, rB.unit) : null;
    const qA = rA && rA.qty_sold !== null && rA.qty_sold !== undefined ? Number(rA.qty_sold) : null;
    const qB = rB && rB.qty_sold !== null && rB.qty_sold !== undefined ? Number(rB.qty_sold) : null;
    const pPct = pA !== null && pB !== null && pA > 0 ? ((pB - pA) / pA) * 100 : null;
    const qPct = qA !== null && qB !== null && qA > 0 ? ((qB - qA) / qA) * 100 : null;

    rows.push({
      name,
      unit: u,
      pLabel: getPriceUnitLabel(u),
      qLabel: u || "Units",
      pA,
      pB,
      pDiff: pA !== null && pB !== null ? pB - pA : null,
      pPct,
      qA,
      qB,
      qDiff: qA !== null && qB !== null ? qB - qA : null,
      qPct,
    });
  }

  // Sort rows
  if (state.d2dSort === "price-up") {
    rows.sort((a, b) => (b.pPct ?? -Infinity) - (a.pPct ?? -Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "price-down") {
    rows.sort((a, b) => (a.pPct ?? Infinity) - (b.pPct ?? Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "vol-drop") {
    rows.sort((a, b) => (a.qPct ?? Infinity) - (b.qPct ?? Infinity) || a.name.localeCompare(b.name));
  } else if (state.d2dSort === "vol-high") {
    rows.sort((a, b) => (b.qB ?? -Infinity) - (a.qB ?? -Infinity) || a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  document.getElementById("d2d-table-count").textContent = `${rows.length} ${rows.length === 1 ? "item" : "items"}`;

  const tbody = document.getElementById("d2d-table-body");
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.style.textAlign = "center";
    td.style.color = "#6f8178";
    td.style.padding = "20px";
    td.textContent = "No market records match these dates and filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.name === state.selectedItem) tr.classList.add("is-selected-item");
    tr.title = `Click to view ${r.name} across all dashboard charts`;
    tr.addEventListener("click", () => selectPrimaryItem(r.name));

    const th = document.createElement("th");
    th.scope = "row";
    th.innerHTML = `${escapeHtml(r.name)}<span class="item-unit-chip">${escapeHtml(r.pLabel)}</span>`;

    const tdPa = document.createElement("td");
    tdPa.className = "num";
    tdPa.textContent = r.pA !== null ? formatPrice(r.pA) : "—";

    const tdPb = document.createElement("td");
    tdPb.className = "num norm-cell";
    tdPb.textContent = r.pB !== null ? formatPrice(r.pB) : "—";

    const tdPd = document.createElement("td");
    tdPd.className = "num";
    renderPriceTrendCell(tdPd, r.pDiff, r.pPct);

    const tdQa = document.createElement("td");
    tdQa.className = "num";
    tdQa.textContent = r.qA !== null ? formatQty(r.qA) : "—";

    const tdQb = document.createElement("td");
    tdQb.className = "num";
    tdQb.textContent = r.qB !== null ? formatQty(r.qB) : "—";

    const tdQd = document.createElement("td");
    tdQd.className = "num";
    if (r.qDiff !== null) {
      if (Math.abs(r.qDiff) < 1e-6) {
        tdQd.textContent = "→ 0%";
      } else {
        const cls = r.qPct !== null && r.qPct < -30 ? "delta-drop" : r.qDiff > 0 ? "delta-down" : "delta-up";
        tdQd.innerHTML = `<span class="${cls}">${formatSignedPct(r.qPct)}</span>`;
      }
    } else {
      tdQd.textContent = "—";
    }

    tr.append(th, tdPa, tdPb, tdPd, tdQa, tdQb, tdQd);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Top-Level Tabs & Market Movers (macOS Stocks-Style View)
// ---------------------------------------------------------------------------

// Official AMB NWM Fruits table items (normalized lowercase keys)
const FRUIT_ITEM_KEYS = new Set([
  "ananas",
  "apricot",
  "avocado",
  "avocat",
  "banane",
  "bilainbi",
  "bilinbi",
  "caranbol",
  "cherry",
  "citron",
  "coco",
  "coeur de boeuf",
  "corossol",
  "fig",
  "fraise",
  "frisiter",
  "fruit a pain",
  "goyave",
  "grenade",
  "grenadine curry",
  "grenadinne",
  "grenadinne (curry)",
  "grenadinne (jus)",
  "jamalac",
  "ker de bef",
  "kiwi",
  "leksi",
  "letchi",
  "limon",
  "longanne",
  "lucuma",
  "mandarine",
  "mandarine (local)",
  "mangue",
  "masson",
  "melon",
  "melon d'eau",
  "mirt",
  "mirtille (blueberry)",
  "olive",
  "orange",
  "orange (loc)",
  "pamplemousse",
  "papaye",
  "patate chinois",
  "peche",
  "pitaya",
  "poire",
  "pomme",
  "prune",
  "raisin",
  "roselle",
  "rozelle",
  "tamarin",
  "tamarine",
  "zacques",
  "zanblon",
  "zatte",
]);

function getItemCategory(itemName) {
  return FRUIT_ITEM_KEYS.has(normalizeSearchKey(itemName)) ? "fruit" : "vegetable";
}

function switchAppTab(tabKey, focusTab = false) {
  state.activeAppTab = tabKey === "movers" ? "movers" : "dashboard";
  const tabDashboard = document.getElementById("tab-dashboard");
  const tabMovers = document.getElementById("tab-movers");
  const panelDashboard = document.getElementById("panel-dashboard");
  const panelMovers = document.getElementById("panel-movers");
  if (!tabDashboard || !tabMovers || !panelDashboard || !panelMovers) return;

  const isMovers = state.activeAppTab === "movers";
  const tabs = [
    { el: tabDashboard, active: !isMovers },
    { el: tabMovers, active: isMovers },
  ];

  for (const { el, active } of tabs) {
    el.setAttribute("aria-selected", active ? "true" : "false");
    el.tabIndex = active ? 0 : -1;
    el.toggleAttribute("focusgroupstart", active);
    if (active) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (focusTab) el.focus();
    }
  }

  panelDashboard.hidden = isMovers;
  panelMovers.hidden = !isMovers;

  if (isMovers) {
    renderMarketMovers();
  } else {
    renderAllViews();
  }
}

function buildSparklineSvg(values, dirClass, uid) {
  const width = 136;
  const height = 36;
  const padX = 4;
  const padY = 5;

  const strokeColor =
    dirClass === "up" ? "#059669" : dirClass === "down" ? "#dc2626" : "#64748b";
  const fillStart =
    dirClass === "up"
      ? "rgba(5, 150, 105, 0.24)"
      : dirClass === "down"
        ? "rgba(220, 38, 38, 0.22)"
        : "rgba(100, 116, 139, 0.16)";

  if (!values || values.length < 2) {
    const midY = (height / 2).toFixed(1);
    return `
      <svg class="mover-sparkline-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <line x1="${padX}" y1="${midY}" x2="${width - padX}" y2="${midY}" stroke="${strokeColor}" stroke-width="2" stroke-dasharray="3 3"/>
      </svg>`;
  }

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const coords = values.map((v, idx) => {
    const x = padX + (idx / (values.length - 1)) * innerW;
    const normY = span > 1e-6 ? (v - minVal) / span : 0.5;
    const y = padY + innerH - normY * innerH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const pointsAttr = coords.map(([x, y]) => `${x},${y}`).join(" ");
  const [firstX] = coords[0];
  const [lastX, lastY] = coords[coords.length - 1];
  const areaPoints = `${firstX},${height - 2} ${pointsAttr} ${lastX},${height - 2}`;

  return `
    <svg class="mover-sparkline-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <defs>
        <linearGradient id="spark-grad-${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${fillStart}"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </linearGradient>
      </defs>
      <polygon points="${areaPoints}" fill="url(#spark-grad-${uid})"/>
      <polyline points="${pointsAttr}" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="3" fill="${strokeColor}"/>
    </svg>`;
}

function downsampleSparkPoints(vals, maxPts = 60) {
  if (!Array.isArray(vals) || vals.length <= maxPts) return vals;
  const out = [];
  const lastIdx = vals.length - 1;
  for (let i = 0; i < maxPts; i++) {
    const idx = Math.round((i / (maxPts - 1)) * lastIdx);
    out.push(vals[idx]);
  }
  return out;
}

function computeMarketMovers() {
  if (!state.rawData) return [];
  const maxIso = state.rawData.date_range?.max_iso;
  const minIso = state.rawData.date_range?.min_iso || "2024-01-01";
  if (!maxIso) return [];

  const tf = state.moversTimeframe;
  const daysMap = { "14D": 13, "30D": 29, "60D": 59, "90D": 89 };
  const cutoffIso =
    tf === "1D"
      ? null
      : tf === "ALL"
        ? minIso
        : subtractDaysIso(maxIso, daysMap[tf] || 13);

  const items = state.rawData.items || [];
  const movers = [];

  for (const itemName of items) {
    const allRecs = state.recordsByItem.get(itemName) || [];
    const priceRecs = allRecs.filter((r) => r.norm_price !== null && r.norm_price !== undefined);
    if (priceRecs.length < 2) continue;

    if (tf === "1D") {
      const latestRec = priceRecs[priceRecs.length - 1];
      const prevRec = priceRecs[priceRecs.length - 2];
      const unit = latestRec.unit || state.itemLatestUnit.get(itemName) || "";
      const pLabel = getPriceUnitLabel(unit);
      const latestPrice = convertPrice(latestRec.norm_price, latestRec.unit);
      const baselinePrice = convertPrice(prevRec.norm_price, prevRec.unit);
      if (latestPrice === null || baselinePrice === null || baselinePrice <= 0) continue;

      const diff = latestPrice - baselinePrice;
      const pct = (diff / baselinePrice) * 100;
      const sparkSlice = priceRecs.slice(-10).map((r) => convertPrice(r.norm_price, r.unit)).filter((v) => v !== null);

      movers.push({
        item: itemName,
        category: getItemCategory(itemName),
        unit,
        pLabel,
        qLabel: unit || "Units",
        latestPrice,
        latestDate: formatIsoDDMMYY(latestRec.date_iso),
        latestIso: latestRec.date_iso,
        latestQty: latestRec.qty_sold,
        baselinePrice,
        baselineLabel: `Prev (${formatIsoDDMMYY(prevRec.date_iso)}): Rs ${formatPrice(baselinePrice)}`,
        diff,
        pct,
        direction: Math.abs(diff) < 1e-6 ? "flat" : diff > 0 ? "up" : "down",
        sparkPoints: sparkSlice,
      });
    } else {
      const windowRecs = priceRecs.filter((r) => r.date_iso >= cutoffIso && r.date_iso <= maxIso);
      if (windowRecs.length < 2) continue;

      const latestRec = windowRecs[windowRecs.length - 1];
      const unit = latestRec.unit || state.itemLatestUnit.get(itemName) || "";
      const pLabel = getPriceUnitLabel(unit);
      const convertedVals = windowRecs.map((r) => convertPrice(r.norm_price, r.unit)).filter((v) => v !== null);
      if (convertedVals.length < 2) continue;

      const latestPrice = convertedVals[convertedVals.length - 1];
      const avgPrice = convertedVals.reduce((a, b) => a + b, 0) / convertedVals.length;
      if (avgPrice <= 0) continue;

      const diff = latestPrice - avgPrice;
      const pct = (diff / avgPrice) * 100;
      const tfLabel = tf === "ALL" ? "All-Time" : tf;

      movers.push({
        item: itemName,
        category: getItemCategory(itemName),
        unit,
        pLabel,
        qLabel: unit || "Units",
        latestPrice,
        latestDate: formatIsoDDMMYY(latestRec.date_iso),
        latestIso: latestRec.date_iso,
        latestQty: latestRec.qty_sold,
        baselinePrice: avgPrice,
        baselineLabel: `${tfLabel} Avg (${convertedVals.length}d): Rs ${formatPrice(avgPrice)}`,
        diff,
        pct,
        direction: Math.abs(pct) < 0.05 ? "flat" : diff > 0 ? "up" : "down",
        sparkPoints: downsampleSparkPoints(convertedVals, 60),
      });
    }
  }

  return movers;
}

function formatMoverBadgeText(m) {
  const arrow = m.direction === "up" ? "▲" : m.direction === "down" ? "▼" : "→";
  if (state.moversBadgeMode === "abs") {
    if (m.direction === "flat") return `${arrow} Rs 0.00`;
    const sign = m.diff > 0 ? "+" : "-";
    return `${arrow} ${sign}Rs ${formatPrice(Math.abs(m.diff))}`;
  }
  if (m.direction === "flat") return `${arrow} 0.0%`;
  return `${arrow} ${formatSignedPct(m.pct)}`;
}

function renderMarketMovers() {
  if (!state.rawData) return;

  const maxIso = state.rawData.date_range?.max_iso || "";
  const maxDisp = formatIsoDDMMYY(maxIso);
  const asofEl = document.getElementById("movers-asof-badge");
  if (asofEl) {
    asofEl.textContent = `Latest Bulletin: ${maxDisp} · Showing ${state.priceUnit === "lb" ? "Rs/lb" : "Rs/kg"}`;
  }

  const allMovers = computeMarketMovers();
  const vegTotal = allMovers.filter((m) => m.category === "vegetable").length;
  const fruitTotal = allMovers.filter((m) => m.category === "fruit").length;

  const catAllBtn = document.getElementById("movers-cat-all");
  const catVegBtn = document.getElementById("movers-cat-veg");
  const catFruitBtn = document.getElementById("movers-cat-fruit");
  if (catAllBtn) catAllBtn.textContent = `Both Separated (${allMovers.length})`;
  if (catVegBtn) catVegBtn.textContent = `Vegetables (${vegTotal})`;
  if (catFruitBtn) catFruitBtn.textContent = `Fruits (${fruitTotal})`;

  // Scope movers by active category filter for Top 3 Gainers/Losers and direction counts
  const categoryScoped =
    state.moversCategory === "all"
      ? allMovers
      : allMovers.filter((m) => m.category === state.moversCategory);

  const gainers = categoryScoped.filter((m) => m.direction === "up").sort((a, b) => b.pct - a.pct);
  const losers = categoryScoped.filter((m) => m.direction === "down").sort((a, b) => a.pct - b.pct);
  const unchanged = categoryScoped.filter((m) => m.direction === "flat");

  // Update tab summary badge & filter pill counts
  const tabSummaryEl = document.getElementById("movers-tab-summary");
  if (tabSummaryEl) {
    const allUp = allMovers.filter((m) => m.direction === "up").length;
    const allDown = allMovers.filter((m) => m.direction === "down").length;
    tabSummaryEl.textContent = `▲ ${allUp} · ▼ ${allDown}`;
  }

  document.getElementById("movers-filter-all").textContent = `All (${categoryScoped.length})`;
  document.getElementById("movers-filter-gainers").textContent = `Gainers ▲ (${gainers.length})`;
  document.getElementById("movers-filter-losers").textContent = `Losers ▼ (${losers.length})`;
  document.getElementById("movers-filter-unchanged").textContent = `Unchanged (${unchanged.length})`;

  // Render Top 3 Gainers & Top 3 Losers Strip
  const topStrip = document.getElementById("top-movers-strip");
  const top3Up = gainers.slice(0, 3);
  const top3Down = losers.slice(0, 3);
  const catScopeTitle =
    state.moversCategory === "vegetable"
      ? "Vegetables · "
      : state.moversCategory === "fruit"
        ? "Fruits · "
        : "";

  const renderTopMiniCard = (m) => `
    <button type="button" class="top-mover-mini" data-mover-item="${escapeHtml(m.item)}" title="Inspect ${escapeHtml(m.item)} in Dashboard">
      <div class="top-mover-mini-name">${escapeHtml(m.item)}</div>
      <div class="top-mover-mini-price">Rs ${formatPrice(m.latestPrice)} <span class="mover-price-unit">${escapeHtml(m.pLabel)}</span></div>
      <div class="top-mover-mini-sub">${escapeHtml(m.baselineLabel)}</div>
      <span class="mover-pill mover-pill--${m.direction}">${escapeHtml(formatMoverBadgeText(m))}</span>
    </button>`;

  const tfDisplay = state.moversTimeframe === "ALL" ? "All Data" : state.moversTimeframe;
  topStrip.innerHTML = `
    <div class="top-movers-group top-movers-group--gainers">
      <div class="top-movers-group-title">
        <span>${catScopeTitle}Top 3 Gainers (▲ ${tfDisplay})</span>
        <span>${gainers.length} up</span>
      </div>
      <div class="top-movers-cards">
        ${top3Up.length ? top3Up.map(renderTopMiniCard).join("") : '<div class="mover-meta">No gainers in this timeframe.</div>'}
      </div>
    </div>
    <div class="top-movers-group top-movers-group--losers">
      <div class="top-movers-group-title">
        <span>${catScopeTitle}Top 3 Losers (▼ ${tfDisplay})</span>
        <span>${losers.length} down</span>
      </div>
      <div class="top-movers-cards">
        ${top3Down.length ? top3Down.map(renderTopMiniCard).join("") : '<div class="mover-meta">No losers in this timeframe.</div>'}
      </div>
    </div>`;

  topStrip.querySelectorAll(".top-mover-mini").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.dataset.moverItem;
      if (item) {
        selectPrimaryItem(item);
        switchAppTab("dashboard");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  });

  // Filter & sort watchlist
  const q = normalizeSearchKey(state.moversSearch);
  let filtered = categoryScoped.filter((m) => {
    if (state.moversFilter === "gainers" && m.direction !== "up") return false;
    if (state.moversFilter === "losers" && m.direction !== "down") return false;
    if (state.moversFilter === "unchanged" && m.direction !== "flat") return false;
    if (q && !normalizeSearchKey(m.item).includes(q)) return false;
    return true;
  });

  if (state.moversSort === "gain-desc") {
    filtered.sort((a, b) => b.pct - a.pct || a.item.localeCompare(b.item));
  } else if (state.moversSort === "drop-asc") {
    filtered.sort((a, b) => a.pct - b.pct || a.item.localeCompare(b.item));
  } else if (state.moversSort === "price-desc") {
    filtered.sort((a, b) => b.latestPrice - a.latestPrice || a.item.localeCompare(b.item));
  } else {
    filtered.sort((a, b) => a.item.localeCompare(b.item));
  }

  const listEl = document.getElementById("movers-watchlist");
  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-state">No NWM commodities match your current Market Movers filter.</div>`;
    return;
  }

  let sparkCounter = 0;
  const renderMoverRow = (m) => {
    sparkCounter += 1;
    const qtyNote =
      m.latestQty !== null && m.latestQty !== undefined
        ? ` · Qty: ${formatQty(m.latestQty)} ${m.qLabel}`
        : "";
    return `
      <div class="mover-row" role="listitem" tabindex="0" data-mover-item="${escapeHtml(m.item)}" title="Click to inspect ${escapeHtml(m.item)} in Dashboard">
        <div class="mover-info">
          <div class="mover-name-line">
            <span class="mover-name">${escapeHtml(m.item)}</span>
            <span class="mover-unit-chip">${escapeHtml(m.pLabel)}</span>
          </div>
          <div class="mover-meta">Latest: ${escapeHtml(m.latestDate)} · ${escapeHtml(m.baselineLabel)}${escapeHtml(qtyNote)}</div>
        </div>
        <div class="mover-sparkline-wrap">
          ${buildSparklineSvg(m.sparkPoints, m.direction, sparkCounter)}
        </div>
        <div class="mover-quote">
          <div class="mover-price-block">
            <div class="mover-price-val">Rs ${formatPrice(m.latestPrice)}</div>
            <div class="mover-price-unit">${escapeHtml(m.pLabel)}</div>
          </div>
          <button type="button" class="mover-pill mover-pill--${m.direction}" title="Click to toggle % change vs Rs change">
            ${escapeHtml(formatMoverBadgeText(m))}
          </button>
        </div>
      </div>`;
  };

  const renderCategoryBlock = (catKey, titleText, itemsList) => {
    if (!itemsList.length) return "";
    const upCnt = itemsList.filter((m) => m.direction === "up").length;
    const downCnt = itemsList.filter((m) => m.direction === "down").length;
    const flatCnt = itemsList.filter((m) => m.direction === "flat").length;
    return `
      <div class="movers-category-block movers-category-block--${catKey}">
        <div class="movers-category-header">
          <span class="movers-category-title">${escapeHtml(titleText)} (${itemsList.length})</span>
          <span class="movers-category-stats">▲ ${upCnt} up · ▼ ${downCnt} down · → ${flatCnt} unchanged</span>
        </div>
        <div class="movers-category-list" role="list">
          ${itemsList.map(renderMoverRow).join("")}
        </div>
      </div>`;
  };

  const vegRows = filtered.filter((m) => m.category === "vegetable");
  const fruitRows = filtered.filter((m) => m.category === "fruit");

  listEl.innerHTML =
    renderCategoryBlock("vegetable", "Vegetables", vegRows) +
    renderCategoryBlock("fruit", "Fruits", fruitRows);

  listEl.querySelectorAll(".mover-row").forEach((row) => {
    const pillBtn = row.querySelector(".mover-pill");
    pillBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.moversBadgeMode = state.moversBadgeMode === "pct" ? "abs" : "pct";
      renderMarketMovers();
    });

    const activateRow = () => {
      const item = row.dataset.moverItem;
      if (item) {
        selectPrimaryItem(item);
        switchAppTab("dashboard");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    };

    row.addEventListener("click", activateRow);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateRow();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestration & Quick Pins
// ---------------------------------------------------------------------------

function updateQuickPinActiveStates() {
  document.querySelectorAll(".quick-pins .pin-btn").forEach((btn) => {
    const resolved = resolveBestItemMatch(btn.dataset.pin, state.rawData?.items || []);
    btn.disabled = !resolved;
    btn.classList.toggle("is-active", Boolean(resolved) && resolved === state.selectedItem);
  });
}

function selectPrimaryItem(itemName) {
  if (!itemName) return;
  state.selectedItem = itemName;
  state.comboboxes.primary?.setValue(itemName);
  if (!state.compareACustom) {
    state.compareItemA = itemName;
    state.comboboxes.compareA?.setValue(itemName);
  }
  updateQuickPinActiveStates();
  renderAllViews();
}

function renderAllViews() {
  if (!state.rawData || !state.selectedItem) return;
  const records = getItemRecordsInRange(state.selectedItem);
  renderKPIs(records);
  renderDailyCharts(records);
  renderPommeDamourStacked();
  renderDateToDateComparison();
  renderMonthlyComparison();
  renderSideBySideComparison();
  renderMarketMovers();
}

// ---------------------------------------------------------------------------
// Data Loading, Live Update Notifications & Incremental Sync
// ---------------------------------------------------------------------------

function showToast(message, isError = false, durationMs = 7000) {
  const toast = document.getElementById("sync-toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, durationMs);
}

async function checkForNewData() {
  if (!state.rawData || document.visibilityState === "hidden") return;
  try {
    const resp = await fetch(`data/nwm_data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return;
    const fresh = await resp.json();
    const currentMaxIso = state.rawData?.date_range?.max_iso || "";
    const freshMaxIso = fresh?.date_range?.max_iso || "";
    if (freshMaxIso && freshMaxIso > currentMaxIso) {
      await loadDataset(true);
      const disp = fresh.last_updated || formatIsoDDMMYY(freshMaxIso);
      showToast(`New NWM bulletin published: ${disp} — Dashboard updated!`, false, 12000);
    }
  } catch {
    // Silent ignore when offline or network transiently unavailable
  }
}

async function loadDataset(preserveSelection = false) {
  const resp = await fetch(`data/nwm_data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Could not load data/nwm_data.json (HTTP ${resp.status})`);
  }
  const data = await resp.json();
  const prevMaxIso = state.rawData?.date_range?.max_iso || "";

  indexDataset(data);

  // Header metadata strictly in dd/mm/yy
  const minDisp = data.date_range?.min || formatIsoDDMMYY(data.date_range?.min_iso);
  const maxDisp = data.date_range?.max || formatIsoDDMMYY(data.date_range?.max_iso);
  const currentMaxIso = data.date_range?.max_iso || "";
  document.getElementById("meta-last-updated").textContent = `Last bulletin: ${data.last_updated || maxDisp}`;
  document.getElementById("meta-coverage").textContent =
    `${minDisp} – ${maxDisp} · ${data.total_trading_days} days · ${data.items.length} items`;

  // In-app notification when opening the app if a newer bulletin arrived since last visit
  if (!preserveSelection && currentMaxIso) {
    try {
      const lastSeenIso = localStorage.getItem(LAST_SEEN_DATE_KEY);
      if (lastSeenIso && currentMaxIso > lastSeenIso) {
        showToast(
          `New NWM bulletin available: ${data.last_updated || maxDisp} (${data.items.length} items loaded).`,
          false,
          10000
        );
      } else if (lastSeenIso && currentMaxIso <= lastSeenIso) {
        showToast(
          `No new data available · Latest bulletin: ${data.last_updated || maxDisp}.`,
          true,
          6000
        );
      }
      localStorage.setItem(LAST_SEEN_DATE_KEY, currentMaxIso);
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  } else if (preserveSelection && currentMaxIso) {
    try {
      localStorage.setItem(LAST_SEEN_DATE_KEY, currentMaxIso);
    } catch {
      // Ignore
    }
  }

  // Populate comboboxes dynamically from data.items
  state.comboboxes.primary.setItems(data.items);
  state.comboboxes.compareA.setItems(data.items);
  state.comboboxes.compareB.setItems(data.items);

  if (!preserveSelection || !data.items.includes(state.selectedItem)) {
    const defaultItem =
      resolveBestItemMatch("Pomme d'Amour (Terre)", data.items) ||
      resolveBestItemMatch("Pomme d'Amour (Serre)", data.items) ||
      data.items[0] ||
      "";
    state.selectedItem = defaultItem;
  }

  if (!preserveSelection || !data.items.includes(state.compareItemA)) {
    state.compareItemA = state.selectedItem;
  }

  if (!preserveSelection || !data.items.includes(state.compareItemB)) {
    const defaultB =
      resolveBestItemMatch("Pomme d'Amour (Serre)", data.items) !== state.compareItemA
        ? resolveBestItemMatch("Pomme d'Amour (Serre)", data.items)
        : resolveBestItemMatch("Poivron (Rouge)", data.items) || data.items[1] || data.items[0] || "";
    state.compareItemB = defaultB;
  }

  state.comboboxes.primary.setValue(state.selectedItem);
  state.comboboxes.compareA.setValue(state.compareItemA);
  state.comboboxes.compareB.setValue(state.compareItemB);

  renderYearCheckboxes();

  // Initialize Date-to-Date & Month-to-Month defaults (default Date A = Prev Trading Day for instant daily trends)
  if (!preserveSelection || !state.d2dDateA || !state.d2dDateB) {
    const latestIso = data.date_range?.max_iso || "";
    const minIso = data.date_range?.min_iso || "";
    if (latestIso) {
      const { prev } = findAdjacentTradingDates(latestIso);
      const fallbackYoY = clampIso(subtractYearsIso(latestIso, 1), minIso, latestIso);
      state.d2dDateB = latestIso;
      state.d2dDateA = prev || findNearestTradingDate(fallbackYoY) || fallbackYoY;
      syncD2DInputsUI();
    }
  } else if (state.d2dDateB === prevMaxIso && data.date_range?.max_iso) {
    const latestIso = data.date_range.max_iso;
    const { prev } = findAdjacentTradingDates(latestIso);
    state.d2dDateB = latestIso;
    if (state.d2dDateA === findAdjacentTradingDates(prevMaxIso).prev && prev) {
      state.d2dDateA = prev;
    }
    syncD2DInputsUI();
  }

  if (state.sortedYearMonths.length) {
    const latestYm = state.sortedYearMonths[state.sortedYearMonths.length - 1];
    const prevMaxYm = prevMaxIso ? prevMaxIso.slice(0, 7) : "";
    if (!preserveSelection || !state.recordsByYearMonth.has(state.d2dMonthA) || !state.recordsByYearMonth.has(state.d2dMonthB)) {
      state.d2dMonthB = latestYm;
      const targetYmA = subtractYearMonth(latestYm, { years: 1 });
      state.d2dMonthA = state.recordsByYearMonth.has(targetYmA)
        ? targetYmA
        : state.sortedYearMonths[Math.max(0, state.sortedYearMonths.length - 2)];
    } else if (state.d2dMonthB === prevMaxYm) {
      state.d2dMonthB = latestYm;
    }
    populateMonthSelects();
  }
  syncD2DModeUI();

  if (!preserveSelection) {
    applyPreset("30d");
  } else {
    // If user was on a preset or pinned to latest date, advance to new max date
    if (state.activePreset !== "custom") {
      applyPreset(state.activePreset);
    } else if (state.toIso === prevMaxIso && data.date_range?.max_iso) {
      state.toIso = data.date_range.max_iso;
      syncDateInputsUI();
      renderAllViews();
    } else {
      syncDateInputsUI();
      renderAllViews();
    }
  }

  updateQuickPinActiveStates();
}

function isLocalHostRuntime() {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
}

function getDefaultSyncButtonLabel() {
  return isLocalHostRuntime() ? "Sync Latest NWM Data" : "Refresh NWM Data";
}

async function triggerIncrementalSync() {
  const btn = document.getElementById("btn-sync");
  const label = document.getElementById("btn-sync-label");
  const isLocal = isLocalHostRuntime();

  btn.disabled = true;
  btn.classList.add("is-syncing");
  label.textContent = isLocal ? "Syncing AMB bulletins..." : "Refreshing NWM data...";

  try {
    if (!isLocal) {
      // Hosted static mode (Netlify / GitHub Pages): cleanly re-fetch daily-synced JSON
      const prevMaxIso = state.rawData?.date_range?.max_iso || "";
      await loadDataset(true);
      const newMaxIso = state.rawData?.date_range?.max_iso || "";
      const latest = state.rawData?.last_updated || formatIsoDDMMYY(newMaxIso);
      const totalDays = state.rawData?.total_trading_days ?? 0;
      const totalItems = state.rawData?.items?.length ?? 0;
      if (newMaxIso && prevMaxIso && newMaxIso > prevMaxIso) {
        showToast(`New NWM data available: ${latest} (${totalDays} trading days, ${totalItems} items).`, false, 10000);
      } else {
        showToast(`No new data available · Latest bulletin: ${latest}.`, true, 6000);
      }
      return;
    }

    // Local mode via start_app.py: trigger incremental Python scraper via /api/sync
    const resp = await fetch("/api/sync", { method: "POST" });

    // Graceful fallback if served locally via a static server without /api/sync
    if (resp.status === 404 || resp.status === 405) {
      await loadDataset(true);
      const latest = state.rawData?.last_updated || formatIsoDDMMYY(state.rawData?.date_range?.max_iso);
      showToast(`Refreshed NWM data · Last updated: ${latest}.`);
      return;
    }

    const payload = await resp.json();
    if (!resp.ok || payload.status === "error") {
      throw new Error(payload.message || `Sync failed (HTTP ${resp.status})`);
    }
    if (payload.status === "busy") {
      showToast(payload.message, false);
      return;
    }

    await loadDataset(true);

    if (payload.new_dates_added > 0) {
      showToast(
        `Synced ${payload.new_dates_added} new bulletin(s) (+${payload.new_records_added} records) · Latest: ${payload.last_updated} (${payload.duration_seconds}s).`
      );
    } else {
      showToast(
        `No new data available · Already up to date through ${payload.last_updated} (${payload.duration_seconds}s).`,
        true,
        6000
      );
    }
  } catch (err) {
    showToast(`${isLocal ? "Sync" : "Refresh"} failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-syncing");
    label.textContent = getDefaultSyncButtonLabel();
  }
}

function bindInstallButton() {
  const installBtn = document.getElementById("btn-install-app");
  if (!installBtn) return;

  const supportsWebInstall = typeof Navigator.prototype.install === "function";
  let deferredInstallPrompt;

  if (supportsWebInstall) {
    installBtn.hidden = false;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (!supportsWebInstall) {
      installBtn.hidden = false;
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = undefined;
    installBtn.hidden = true;
    showToast("NWM Market Analyzer installed on your device.");
  });

  installBtn.addEventListener("click", async () => {
    if (installBtn.getAttribute("aria-disabled") === "true") return;
    installBtn.setAttribute("aria-disabled", "true");
    try {
      if (supportsWebInstall) {
        await navigator.install();
        installBtn.hidden = true;
      } else if (deferredInstallPrompt) {
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = undefined;
        await promptEvent.prompt();
        const { outcome } = await promptEvent.userChoice;
        if (outcome === "accepted") {
          installBtn.hidden = true;
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.error(error);
      }
    } finally {
      installBtn.removeAttribute("aria-disabled");
    }
  });
}

// ---------------------------------------------------------------------------
// Event Wiring & Bootstrap
// ---------------------------------------------------------------------------

function bindControls() {
  state.comboboxes.primary = createCombobox({
    containerId: "primary-combobox",
    inputId: "item-search-input",
    listboxId: "item-listbox",
    onSelect: (item) => selectPrimaryItem(item),
  });

  state.comboboxes.compareA = createCombobox({
    containerId: "compare-a-combobox",
    inputId: "compare-a-input",
    listboxId: "compare-a-listbox",
    onSelect: (item) => {
      state.compareItemA = item;
      state.compareACustom = true;
      renderSideBySideComparison();
    },
  });

  state.comboboxes.compareB = createCombobox({
    containerId: "compare-b-combobox",
    inputId: "compare-b-input",
    listboxId: "compare-b-listbox",
    onSelect: (item) => {
      state.compareItemB = item;
      renderSideBySideComparison();
    },
  });

  // Quick-pin buttons (scoped to Dashboard quick-pins container)
  document.querySelectorAll(".quick-pins .pin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const resolved = resolveBestItemMatch(btn.dataset.pin, state.rawData?.items || []);
      if (resolved) selectPrimaryItem(resolved);
    });
  });

  // Global Unit Toggle (Rs/lb vs Rs/kg)
  document.querySelectorAll('input[name="price-unit"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.priceUnit = e.target.value;
      renderAllViews();
    });
  });

  // Date presets (scoped to Dashboard date-presets container)
  document.querySelectorAll(".date-presets .preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  // Custom dd/mm/yy inputs + native calendar picker buttons
  const fromDisplay = document.getElementById("from-date-display");
  const toDisplay = document.getElementById("to-date-display");
  const fromNative = document.getElementById("from-date-native");
  const toNative = document.getElementById("to-date-native");

  function handleManualDateCommit() {
    const fIso = parseDDMMYYToIso(fromDisplay.value);
    const tIso = parseDDMMYYToIso(toDisplay.value);
    commitCustomDateRange(fIso, tIso);
  }

  fromDisplay.addEventListener("change", handleManualDateCommit);
  toDisplay.addEventListener("change", handleManualDateCommit);
  fromDisplay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleManualDateCommit();
  });
  toDisplay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleManualDateCommit();
  });

  document.getElementById("from-date-picker-btn").addEventListener("click", () => {
    if (typeof fromNative.showPicker === "function") fromNative.showPicker();
    else fromNative.focus();
  });
  document.getElementById("to-date-picker-btn").addEventListener("click", () => {
    if (typeof toNative.showPicker === "function") toNative.showPicker();
    else toNative.focus();
  });

  fromNative.addEventListener("change", () => {
    if (fromNative.value) commitCustomDateRange(fromNative.value, state.toIso);
  });
  toNative.addEventListener("change", () => {
    if (toNative.value) commitCustomDateRange(state.fromIso, toNative.value);
  });

  // Primary & Comparison chart Daily vs Regroup by Month toggles
  document.querySelectorAll('input[name="primary-grouping"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.primaryGrouping = e.target.value;
      renderDailyCharts(getItemRecordsInRange(state.selectedItem));
    });
  });

  document.querySelectorAll('input[name="compare-grouping"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.compareGrouping = e.target.value;
      renderSideBySideComparison();
    });
  });

  // Monthly metric radio + match-months toggle
  document.querySelectorAll('input[name="monthly-metric"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.monthlyMetric = e.target.value;
      renderMonthlyComparison();
    });
  });

  document.getElementById("monthly-match-months").addEventListener("change", (e) => {
    state.monthlyMatchMonths = e.target.checked;
    renderMonthlyComparison();
  });

  // Swap Item A & B
  document.getElementById("btn-swap-compare").addEventListener("click", () => {
    const tmp = state.compareItemA;
    state.compareItemA = state.compareItemB;
    state.compareItemB = tmp;
    state.compareACustom = true;
    state.comboboxes.compareA.setValue(state.compareItemA);
    state.comboboxes.compareB.setValue(state.compareItemB);
    renderSideBySideComparison();
  });

  // Pomme d'Amour Stacked (Terre + Serre) controls
  document.querySelectorAll('input[name="tomato-grouping"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.tomatoGrouping = e.target.value;
      renderPommeDamourStacked();
    });
  });

  document.querySelectorAll('input[name="tomato-vol-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.tomatoVolMode = e.target.value;
      renderPommeDamourStacked();
    });
  });

  // Date-to-Date Comparison controls (strict dd/mm/yy + calendar pickers)
  const d2dDispA = document.getElementById("d2d-date-a-display");
  const d2dDispB = document.getElementById("d2d-date-b-display");
  const d2dNatA = document.getElementById("d2d-date-a-native");
  const d2dNatB = document.getElementById("d2d-date-b-native");

  function handleD2DManualCommit() {
    const aIso = parseDDMMYYToIso(d2dDispA.value);
    const bIso = parseDDMMYYToIso(d2dDispB.value);
    setD2DDates(aIso, bIso);
  }

  d2dDispA.addEventListener("change", handleD2DManualCommit);
  d2dDispB.addEventListener("change", handleD2DManualCommit);
  d2dDispA.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleD2DManualCommit();
  });
  d2dDispB.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleD2DManualCommit();
  });

  document.getElementById("d2d-date-a-picker-btn").addEventListener("click", () => {
    if (typeof d2dNatA.showPicker === "function") d2dNatA.showPicker();
    else d2dNatA.focus();
  });
  document.getElementById("d2d-date-b-picker-btn").addEventListener("click", () => {
    if (typeof d2dNatB.showPicker === "function") d2dNatB.showPicker();
    else d2dNatB.focus();
  });

  d2dNatA.addEventListener("change", () => {
    if (d2dNatA.value) setD2DDates(d2dNatA.value, state.d2dDateB);
  });
  d2dNatB.addEventListener("change", () => {
    if (d2dNatB.value) setD2DDates(state.d2dDateA, d2dNatB.value);
  });

  // Date vs Date / Month vs Month mode toggle
  document.querySelectorAll('input[name="d2d-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.d2dMode = e.target.value;
      syncD2DModeUI();
      renderDateToDateComparison();
    });
  });

  document.getElementById("d2d-month-a-select").addEventListener("change", (e) => {
    setD2DMonths(e.target.value, state.d2dMonthB);
  });
  document.getElementById("d2d-month-b-select").addEventListener("change", (e) => {
    setD2DMonths(state.d2dMonthA, e.target.value);
  });
  document.getElementById("btn-swap-m2m").addEventListener("click", () => {
    setD2DMonths(state.d2dMonthB, state.d2dMonthA);
  });

  document.getElementById("btn-swap-d2d").addEventListener("click", () => {
    setD2DDates(state.d2dDateB, state.d2dDateA);
  });

  document.getElementById("btn-d2d-yoy1").addEventListener("click", () => {
    if (state.d2dMode === "month") {
      if (!state.d2dMonthB) return;
      setD2DMonths(subtractYearMonth(state.d2dMonthB, { years: 1 }), state.d2dMonthB);
      return;
    }
    if (!state.d2dDateB) return;
    setD2DDates(subtractYearsIso(state.d2dDateB, 1), state.d2dDateB);
  });

  document.getElementById("btn-d2d-yoy2").addEventListener("click", () => {
    if (state.d2dMode === "month") {
      if (!state.d2dMonthB) return;
      setD2DMonths(subtractYearMonth(state.d2dMonthB, { years: 2 }), state.d2dMonthB);
      return;
    }
    if (!state.d2dDateB) return;
    setD2DDates(subtractYearsIso(state.d2dDateB, 2), state.d2dDateB);
  });

  document.getElementById("btn-d2d-prev").addEventListener("click", () => {
    if (state.d2dMode === "month") {
      if (!state.d2dMonthB) return;
      setD2DMonths(subtractYearMonth(state.d2dMonthB, { months: 1 }), state.d2dMonthB);
      return;
    }
    if (!state.d2dDateB) return;
    const { prev } = findAdjacentTradingDates(state.d2dDateB);
    if (prev) setD2DDates(prev, state.d2dDateB);
  });

  document.getElementById("d2d-table-search").addEventListener("input", (e) => {
    state.d2dSearch = e.target.value;
    renderDateToDateComparison();
  });

  document.getElementById("d2d-table-sort").addEventListener("change", (e) => {
    state.d2dSort = e.target.value;
    renderDateToDateComparison();
  });

  document.getElementById("d2d-both-only").addEventListener("change", (e) => {
    state.d2dBothOnly = e.target.checked;
    renderDateToDateComparison();
  });

  // Top-level tab navigation (Dashboard vs Market Movers)
  const tabDashboard = document.getElementById("tab-dashboard");
  const tabMovers = document.getElementById("tab-movers");
  tabDashboard?.addEventListener("click", () => switchAppTab("dashboard"));
  tabMovers?.addEventListener("click", () => switchAppTab("movers"));

  document.querySelector(".app-tablist")?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? "dashboard"
          : e.key === "End"
            ? "movers"
            : state.activeAppTab === "dashboard"
              ? "movers"
              : "dashboard";
      switchAppTab(next, true);
    }
  });

  // Conditionally load focusgroup polyfill if not natively supported
  if (!Object.hasOwn(HTMLElement.prototype, "focusGroup")) {
    import("https://esm.sh/@microsoft/focusgroup-polyfill")
      .then((mod) => mod.polyfill?.())
      .catch(() => {});
  }

  // Market Movers category, timeframe, filter, search, and sort controls
  document.querySelectorAll("[data-movers-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.moversCategory = btn.dataset.moversCat;
      document.querySelectorAll("[data-movers-cat]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.moversCat === state.moversCategory);
      });
      renderMarketMovers();
    });
  });

  document.querySelectorAll("[data-movers-tf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.moversTimeframe = btn.dataset.moversTf;
      document.querySelectorAll("[data-movers-tf]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.moversTf === state.moversTimeframe);
      });
      renderMarketMovers();
    });
  });

  document.querySelectorAll("[data-movers-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.moversFilter = btn.dataset.moversFilter;
      document.querySelectorAll("[data-movers-filter]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.moversFilter === state.moversFilter);
      });
      renderMarketMovers();
    });
  });

  document.getElementById("movers-search-input")?.addEventListener("input", (e) => {
    state.moversSearch = e.target.value;
    renderMarketMovers();
  });

  document.getElementById("movers-sort-select")?.addEventListener("change", (e) => {
    state.moversSort = e.target.value;
    renderMarketMovers();
  });

  // Sync / Refresh button (hybrid local vs Netlify mode)
  const syncLabel = document.getElementById("btn-sync-label");
  if (syncLabel) syncLabel.textContent = getDefaultSyncButtonLabel();
  document.getElementById("btn-sync").addEventListener("click", triggerIncrementalSync);

  // Auto-check for new NWM bulletins when returning to the app or every 10 minutes
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForNewData();
    }
  });
  setInterval(checkForNewData, 10 * 60 * 1000);

  // Progressive PWA install button
  bindInstallButton();
}

async function init() {
  try {
    await ensureTemporal();
    bindControls();
    await loadDataset(false);
  } catch (err) {
    document.getElementById("meta-coverage").textContent = "Failed to load data";
    showToast(`Initialization error: ${err.message}. Run scrape_nwm.py first.`, true);
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
