// ===================================================================
// PIKE Meeting Tracker — UCLA Quarter Utilities
// ===================================================================

const QUARTERS = ["winter", "spring", "summer", "fall"];

const QUARTER_MONTHS = {
  winter: [0, 1, 2],
  spring: [3, 4, 5],
  summer: [6, 7],
  fall:   [8, 9, 10, 11],
};

const QUARTER_LABELS = {
  winter: "Winter",
  spring: "Spring",
  summer: "Summer",
  fall:   "Fall",
};

export function getQuarterFor(date = new Date()) {
  const month = date.getMonth();
  const year  = date.getFullYear();
  for (const q of QUARTERS) {
    if (QUARTER_MONTHS[q].includes(month)) return `${year}-${q}`;
  }
  return `${year}-fall`;
}

export function currentQuarter() {
  return getQuarterFor(new Date());
}

export function getQuarterForDate(dateString) {
  if (!dateString) return currentQuarter();
  const [y, m, d] = dateString.split("-").map(Number);
  return getQuarterFor(new Date(y, m - 1, d));
}

export function formatQuarter(qid) {
  if (!qid) return "—";
  const [year, q] = qid.split("-");
  return `${QUARTER_LABELS[q] || q} ${year}`;
}

export function quartersFromRecords(...recordLists) {
  const set = new Set();
  recordLists.forEach(list => {
    list.forEach(r => { if (r.quarter) set.add(r.quarter); });
  });
  set.add(currentQuarter());
  return [...set].sort(compareQuartersDesc);
}

export function compareQuartersDesc(a, b) {
  const [ay, aq] = a.split("-");
  const [by, bq] = b.split("-");
  if (ay !== by) return Number(by) - Number(ay);
  return QUARTERS.indexOf(bq) - QUARTERS.indexOf(aq);
}
