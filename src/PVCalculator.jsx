import { useState, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";

const DEFAULT_PARAMS = {
  pvPower: 5,
  pvTotalCost: 1453.85,       // USD total (CPV)
  comPercent: 5,
  eom: 2.7,
  epv: 1500,
  fEpv: 2,
  pEpv: 0.049,                // USD/kWh
  ep: 2.7,
  d: 6,
  n: 25,
  useLoan: false,
  ownCapitalPercent: 25,
  loanYears: 15,
  loanRate: 4.0,
  exchangeRate: 12250,        // 1 USD = 12,250 UZS
};

function computeLoanPayment(principal, annualRate, years) {
  if (annualRate === 0) return principal / years;
  const r = annualRate / 100;
  return (principal * r) / (1 - Math.pow(1 + r, -years));
}

// All monetary values are in UZS internally.
// NPV = Σ(t=0..n) [Rt - Kt] / (1+d)^t
// t=0: K0=Cpv (investment, undiscounted), R0=0
// t=1..n: Rt=Epv*(1-f)^(t-1)*Pepv*(1+ep)^(t-1), Kt=Com*(1+eom)^(t-1) [+Qb]
function calculate(p) {
  const cpv = p.pvTotalCost * p.exchangeRate;          // UZS
  const com = (p.comPercent / 100) * cpv;
  const ownCapital = p.useLoan ? (p.ownCapitalPercent / 100) * cpv : cpv;
  const loanPrincipal = p.useLoan ? cpv - ownCapital : 0;
  const annualLoanPayment = p.useLoan ? computeLoanPayment(loanPrincipal, p.loanRate, p.loanYears) : 0;
  const loanYears = p.useLoan ? p.loanYears : 0;
  const dRate = p.d / 100;
  const fDeg = p.fEpv / 100;
  const eomRate = p.eom / 100;
  const epRate = p.ep / 100;

  // LCOE numerator starts with investment at t=0: cost/(1+d)^0 = ownCapital
  let costSum = ownCapital;
  let energySum = 0;
  const cashFlows = [-ownCapital]; // index 0 = t=0
  const yearlyBreakdown = [];

  // t=0: investment only, R0=0, K0=ownCapital, (1+d)^0=1
  yearlyBreakdown.push({
    t: 0,
    energy: 0, revenue: 0, omCost: 0, loan: 0,
    investment: ownCapital,
    cf: -ownCapital,
    discountFactor: 1,
    cfNumerator: -ownCapital, cfDenominator: 1, discCf: -ownCapital,
    costNumerator: ownCapital, discCost: ownCapital,
    energyDiscountFactor: 1, energyNumerator: 0, discEnergy: 0,
    runningCostSum: costSum, runningEnergySum: 0,
  });

  // t=1..n: operational years
  for (let t = 1; t <= p.n; t++) {
    const discountFactor = Math.pow(1 + dRate, t);
    const energyDiscountFactor = Math.pow(1 + dRate, t - 1);
    const energy = p.pvPower * p.epv * Math.pow(1 - fDeg, t - 1);
    const revenue = energy * p.pEpv * p.exchangeRate * Math.pow(1 + epRate, t - 1);
    const omCost = com * Math.pow(1 + eomRate, t - 1);
    const loan = t <= loanYears ? annualLoanPayment : 0;
    const cf = revenue - omCost - loan;

    const annualCost = omCost + loan;
    const discCost = annualCost / discountFactor;
    const discEnergy = energy / energyDiscountFactor;
    costSum += discCost;
    energySum += discEnergy;

    const discCf = cf / discountFactor;

    cashFlows.push(cf);
    yearlyBreakdown.push({
      t, energy, revenue, omCost, loan, investment: 0, cf,
      discountFactor,
      cfNumerator: cf, cfDenominator: discountFactor, discCf,
      costNumerator: annualCost, discCost, energyDiscountFactor,
      energyNumerator: energy, discEnergy,
      runningCostSum: costSum, runningEnergySum: energySum,
    });
  }
  const lcoe = energySum > 0 ? costSum / energySum : 0;

  // NPV = -ownCapital (t=0) + Σ(t=1..n) CFt/(1+d)^t
  let npv = cashFlows[0];
  for (let i = 1; i < cashFlows.length; i++)
    npv += cashFlows[i] / Math.pow(1 + dRate, i);

  // IRR via bisection
  let irrLow = -0.5, irrHigh = 5.0, irr = 0;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (irrLow + irrHigh) / 2;
    let npvTest = cashFlows[0];
    for (let i = 1; i < cashFlows.length; i++)
      npvTest += cashFlows[i] / Math.pow(1 + mid, i);
    if (npvTest > 0) irrLow = mid; else irrHigh = mid;
    irr = mid;
  }

  // DPBT: cumulative starts at -ownCapital (t=0)
  let cumulative = cashFlows[0], dpbt = p.n;
  for (let i = 1; i < cashFlows.length; i++) {
    const discounted = cashFlows[i] / Math.pow(1 + dRate, i);
    const prev = cumulative;
    cumulative += discounted;
    if (cumulative >= 0) {
      dpbt = (i - 1) + (-prev / discounted);
      break;
    }
  }

  // Yearly data for chart & table (index 0 = year 0)
  const yearlyData = [];
  let cumNpv = cashFlows[0];
  yearlyData.push({ year: 0, cf: cashFlows[0], cumNpv });
  for (let i = 1; i < cashFlows.length; i++) {
    cumNpv += yearlyBreakdown[i].discCf;
    yearlyData.push({ year: i, cf: cashFlows[i], cumNpv });
  }

  return { cpv, lcoe, npv, irr: irr * 100, dpbt, annualLoanPayment, ownCapital, loanPrincipal, yearlyData, yearlyBreakdown };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function toDisplay(uzsVal, currency, rate) {
  return currency === "USD" ? uzsVal / rate : uzsVal;
}

function fmtMoney(val, currency, rate) {
  const v = toDisplay(val, currency, rate);
  const abs = Math.abs(v);
  if (currency === "USD") {
    if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B UZS`;
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M UZS`;
    return `${Math.round(v).toLocaleString("en-US")} UZS`;
  }
}

function fmtLcoe(uzsPerKwh, currency, rate) {
  if (currency === "USD") return `$${(uzsPerKwh / rate).toFixed(4)}/kWh`;
  return `${uzsPerKwh.toFixed(1)} UZS/kWh`;
}

// ── Excel export ─────────────────────────────────────────────────────────────

function makeSummaryComparisonSheet(profiles, currency) {
  if (profiles.length === 0) return XLSX.utils.aoa_to_sheet([["No profiles saved"]]);
  const isUsd = currency === "USD";
  const sym = currency;
  const cv = (v, rate) => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);
  const names = profiles.map(p => p.name);
  const hdr = ["", "Unit", ...names];

  const inputSection = [
    ["INPUTS"],
    hdr,
    ["PV Power", "kW", ...profiles.map(p => p.params.pvPower)],
    ["Total PV Cost", sym, ...profiles.map(p => isUsd ? +p.params.pvTotalCost.toFixed(2) : +(p.params.pvTotalCost * p.params.exchangeRate).toFixed(0))],
    ["O&M Cost", "% of Cpv/yr", ...profiles.map(p => p.params.comPercent)],
    ["O&M Escalation", "%/yr", ...profiles.map(p => p.params.eom)],
    ["Annual PV Yield", "kWh/kW/yr", ...profiles.map(p => p.params.epv)],
    ["Degradation Factor", "%/yr", ...profiles.map(p => p.params.fEpv)],
    ["Electricity Price", `${sym}/kWh`, ...profiles.map(p => isUsd ? p.params.pEpv : +(p.params.pEpv * p.params.exchangeRate).toFixed(2))],
    ["Price Increase", "%/yr", ...profiles.map(p => p.params.ep)],
    ["Discount Rate (WACC)", "%", ...profiles.map(p => p.params.d)],
    ["System Lifetime", "years", ...profiles.map(p => p.params.n)],
    ["Exchange Rate", "UZS/USD", ...profiles.map(p => p.params.exchangeRate)],
    ["Financing", "", ...profiles.map(p => p.params.useLoan ? `Loan (${p.params.ownCapitalPercent}% own)` : "Own Capital")],
  ];

  const resultSection = [
    [],
    ["RESULTS"],
    hdr,
    ["LCOE", `${sym}/kWh`, ...profiles.map(p => cv(p.results.lcoe, p.params.exchangeRate))],
    ["NPV", sym, ...profiles.map(p => cv(p.results.npv, p.params.exchangeRate))],
    ["IRR", "%", ...profiles.map(p => +p.results.irr.toFixed(2))],
    ["DPBT", "years", ...profiles.map(p => +p.results.dpbt.toFixed(1))],
    ["Total System Cost (Cpv)", sym, ...profiles.map(p => cv(p.results.cpv, p.params.exchangeRate))],
    ["Own Capital", sym, ...profiles.map(p => cv(p.results.ownCapital, p.params.exchangeRate))],
    ["Year-1 Revenue", sym, ...profiles.map(p => cv(p.params.pvPower * p.params.epv * p.params.pEpv * p.params.exchangeRate, p.params.exchangeRate))],
    ["Year-1 Energy", "kWh", ...profiles.map(p => p.params.pvPower * p.params.epv)],
  ];

  const ws = XLSX.utils.aoa_to_sheet([
    [`SOLAR PV INVESTMENT CALCULATOR — MULTI-PROFILE SUMMARY (${sym})`],
    [],
    ...inputSection,
    ...resultSection,
  ]);
  ws["!cols"] = [{ wch: 26 }, { wch: 14 }, ...names.map(() => ({ wch: 18 }))];
  return ws;
}

function makeProfileDetailSheet(params, results, currency) {
  const rate = params.exchangeRate;
  const isUsd = currency === "USD";
  const sym = currency;
  const cv = v => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);
  const cvLcoe = v => isUsd ? +(v / rate).toFixed(6) : +v.toFixed(4);
  const n = params.n;

  // Convert key inputs to display currency
  const cpv_local  = isUsd ? params.pvTotalCost : params.pvTotalCost * rate;
  const pEpv_local = isUsd ? params.pEpv        : params.pEpv * rate;

  const tot = results.yearlyBreakdown.reduce((a, b) => ({
    energy: a.energy + b.energy, revenue: a.revenue + b.revenue,
    omCost: a.omCost + b.omCost, investment: a.investment + b.investment,
    loan: a.loan + b.loan, cf: a.cf + b.cf, discCf: a.discCf + b.discCf,
    costNumerator: a.costNumerator + b.costNumerator, discCost: a.discCost + b.discCost,
    discEnergy: a.discEnergy + b.discEnergy,
  }), { energy:0, revenue:0, omCost:0, investment:0, loan:0, cf:0, discCf:0, costNumerator:0, discCost:0, discEnergy:0 });
  const finalNpv  = results.yearlyData[results.yearlyData.length - 1].cumNpv;
  const finalLcoe = tot.discEnergy > 0 ? tot.discCost / tot.discEnergy : 0;
  const yr1Rev    = params.pvPower * params.epv * params.pEpv * rate;

  // ── Row layout (0-indexed) ───────────────────────────────────────────────
  // INPUTS       rows  0-15  (16 rows: title + blank + 14 param rows)
  // DERIVED      rows 16-22  (7 rows: blank + title + blank + 4 formula rows)
  // KEY OUTPUTS  rows 23-31  (9 rows: blank + title + blank + 6 output rows + blank)
  //   → total preamble = 32 rows (0-31)
  // NPV title/blank/header  rows 32-34
  // NPV data     rows 35..35+n   (n+1 rows, NPV_DATA_START=35)
  // NPV blank/TOTAL/blank   rows 35+n+1..35+n+3
  //   → NPV_TOTAL_ROW = 35+n+2
  // LCOE title/blank/header rows 35+n+4..35+n+6
  // LCOE data    rows 35+n+7..35+2n+7  (LCOE_DATA_START=35+n+7? let me track below)
  //
  // Tracked dynamically via rows.length when each section starts.

  const er = r => r + 1;   // 0-indexed → Excel 1-indexed

  // Cached computed values for formula-cell `v` properties
  const ownCap_v   = cv(results.ownCapital);
  const loanP_v    = cv(results.loanPrincipal);
  const annLoan_v  = cv(results.annualLoanPayment);
  const comYr1_v   = cv((params.comPercent / 100) * results.cpv);

  const rows = [];

  // ── INPUTS (rows 0-15) ───────────────────────────────────────────────────
  rows.push(["=== INPUTS ==="]);                                                    // 0
  rows.push([]);                                                                     // 1
  rows.push(["PV System Power",            params.pvPower,              "kWp"]);    // 2  → B3
  rows.push(["Specific Energy Yield",      params.epv,                  "kWh/kWp"]);// 3 → B4
  rows.push(["Electricity Price",          pEpv_local,                  `${sym}/kWh`]);// 4 → B5
  rows.push(["Annual Degradation Rate",    params.fEpv,                 "%/yr"]);   // 5  → B6
  rows.push(["Price Escalation Rate",      params.ep,                   "%/yr"]);   // 6  → B7
  rows.push(["Discount Rate (WACC, d)",    params.d,                    "%"]);      // 7  → B8
  rows.push(["System Lifetime (n)",        params.n,                    "years"]);  // 8  → B9
  rows.push(["Total System Cost (Cpv)",    cpv_local,                   sym]);      // 9  → B10
  rows.push(["O&M Rate",                   params.comPercent,           "% of Cpv"]);// 10 → B11
  rows.push(["O&M Escalation Rate",        params.eom,                  "%/yr"]);   // 11 → B12
  rows.push(["Loan Enabled (0=No, 1=Yes)", params.useLoan ? 1 : 0,     ""]);       // 12 → B13
  rows.push(["Own Capital %",              params.ownCapitalPercent,    "% of Cpv"]);// 13 → B14
  rows.push(["Loan Interest Rate",         params.loanRate,             "%"]);      // 14 → B15
  rows.push(["Loan Term",                  params.loanYears,            "years"]);  // 15 → B16

  // ── DERIVED INPUTS (rows 16-22) ──────────────────────────────────────────
  rows.push([]);                                                                     // 16
  rows.push(["=== DERIVED INPUTS (auto-calculated) ==="]);                         // 17
  rows.push([]);                                                                     // 18
  rows.push(["Annual O&M Cost (Year 1)", comYr1_v,  sym]);  // 19 → B20
  rows.push(["Own Capital",             ownCap_v,   sym]);  // 20 → B21
  rows.push(["Loan Principal",          loanP_v,    sym]);  // 21 → B22
  rows.push(["Annual Loan Payment",     annLoan_v,  sym]);  // 22 → B23

  // ── KEY OUTPUTS (rows 23-31) ─────────────────────────────────────────────
  rows.push([]);                                                                     // 23
  rows.push(["=== KEY OUTPUTS ==="]);                                               // 24
  rows.push([]);                                                                     // 25
  rows.push(["LCOE",             cv(results.lcoe),           `${sym}/kWh`]);  // 26 → B27
  rows.push(["NPV",              cv(results.npv),            sym]);            // 27 → B28
  rows.push(["IRR",              +results.irr.toFixed(2),    "%"]);            // 28
  rows.push(["DPBT",             +results.dpbt.toFixed(1),   "years"]);        // 29
  rows.push(["Year-1 Revenue",   cv(yr1Rev),                 sym]);            // 30 → B31
  rows.push(["Year-1 Energy",    params.pvPower * params.epv,"kWh"]);          // 31 → B32
  rows.push([]);                                                                // 32

  // rows.length = 33 → NPV title at 32+2=34? Let me check: 0..32 = 33 rows ✓
  // But NPV_DATA_START=35, need rows 32,33,34 = blank already at 32, then 33=title, 34=blank, 35=header? No:
  // rows.length=33 → blank at 32 is last pushed. Need to push: title(33), blank(34), header(35→ but data starts at 35)
  // Actually header is at 34 and data starts at 35. Let me adjust:
  // rows.length after row 32 blank = 33.
  // push title → index 33, length=34
  // push blank → index 34, length=35? No, NPV_DATA_START=35, so I need one more row.
  // push title(33), blank(34), header(35 would be wrong—data starts at 35)
  // I need: title(33), blank(34), header(34)... I'm off by one.
  // Fix: NPV_DATA_START = 36, with title@33, blank@34, header@35, data@36.

  // ── NPV Breakdown (rows 33+) ─────────────────────────────────────────────
  rows.push([`NPV Breakdown — NPV = Σ(t=0..n)[(Rt−Kt)/(1+d)^t]   |   d = ${params.d}%`]); // 33
  rows.push([]);                                                                              // 34
  rows.push(["Year (t)", `Revenue Rt (${sym})`, `Costs Kt (${sym})`, `Rt−Kt (${sym})`, "(1+d)^t", `Disc. CF (${sym})`, `Σ Disc. CF = NPV (${sym})`]); // 35
  // rows.length = 36 = NPV_DS ✓

  results.yearlyBreakdown.forEach((b, i) => {
    const dy = results.yearlyData[i];
    rows.push([b.t, cv(b.revenue), cv(b.costNumerator), cv(b.cfNumerator), +b.cfDenominator.toFixed(6), cv(b.discCf), cv(dy.cumNpv)]);
  });
  rows.push([]);
  rows.push(["TOTAL", cv(tot.revenue), cv(tot.costNumerator), cv(tot.cf), "—", cv(tot.discCf), cv(finalNpv)]);
  rows.push([]);

  // ── LCOE Breakdown ────────────────────────────────────────────────────────
  rows.push([`LCOE Breakdown — LCOE = Σ[Cost_t/(1+d)^t] ÷ Σ[Energy_t/(1+d)^(t−1)]`]);
  rows.push([]);
  rows.push(["Year (t)", `Cost Num. (${sym})`, "(1+d)^t", `Disc. Cost (${sym})`, `Σ Disc. Cost (${sym})`, "Energy (kWh)", "(1+d)^(t-1)", "Disc. Energy (kWh)", "Σ Disc. Energy (kWh)", `Running LCOE (${sym}/kWh)`]);
  results.yearlyBreakdown.forEach(b => {
    const rl = b.runningEnergySum > 0 ? b.runningCostSum / b.runningEnergySum : null;
    rows.push([
      b.t, cv(b.costNumerator), +b.discountFactor.toFixed(6),
      cv(b.discCost), cv(b.runningCostSum),
      b.energyNumerator > 0 ? +b.energyNumerator.toFixed(2) : "—",
      b.t === 0 ? "—" : +b.energyDiscountFactor.toFixed(6),
      b.discEnergy > 0 ? +b.discEnergy.toFixed(2) : "—",
      b.runningEnergySum > 0 ? +b.runningEnergySum.toFixed(2) : "—",
      rl !== null ? cvLcoe(rl) : "—",
    ]);
  });
  rows.push([]);
  rows.push(["TOTAL", cv(tot.costNumerator), "—", cv(tot.discCost), cv(tot.discCost), +tot.energy.toFixed(2), "—", +tot.discEnergy.toFixed(2), +tot.discEnergy.toFixed(2), cvLcoe(finalLcoe)]);
  rows.push([]);

  // ── Cash Flow Detail ──────────────────────────────────────────────────────
  rows.push([`Cash Flow Detail (${sym})`]);
  rows.push([]);
  rows.push(["Year", "Energy (kWh)", `Revenue (${sym})`, `O&M Cost (${sym})`, `Investment (${sym})`, `Loan Payment (${sym})`, `Net CF (${sym})`, `Disc. CF (${sym})`, `Cum. NPV (${sym})`]);
  results.yearlyData.forEach((dy, i) => {
    const b = results.yearlyBreakdown[i];
    rows.push([dy.year, +b.energy.toFixed(2), cv(b.revenue), cv(b.omCost), b.investment > 0 ? cv(b.investment) : 0, b.loan > 0 ? cv(b.loan) : 0, cv(dy.cf), cv(b.discCf), cv(dy.cumNpv)]);
  });
  rows.push([]);
  rows.push(["TOTAL", +tot.energy.toFixed(2), cv(tot.revenue), cv(tot.omCost), cv(tot.investment), cv(tot.loan), cv(tot.cf), cv(tot.discCf), cv(finalNpv)]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 28 }, { wch: 18 }, ...Array(8).fill({ wch: 18 })];

  // ── Inject Excel formulas ────────────────────────────────────────────────
  // Row layout: 33 preamble rows (0-32), then NPV title(33)/blank(34)/header(35)/data(36..)
  const NPV_DS  = 36;   // NPV data rows start (0-indexed)
  const NPV_TOT = NPV_DS  + n + 2;             // 38+n
  const LCOE_DS = NPV_TOT + 5;                 // 43+n
  const LCOE_TOT= LCOE_DS + n + 2;             // 45+2n
  const CF_DS   = LCOE_TOT + 5;                // 50+2n
  const CF_TOT  = CF_DS   + n + 2;             // 52+3n

  const ea = (c, r) => XLSX.utils.encode_cell({ c, r });
  // SheetJS stores formula without leading '=' — Excel prepends it on open
  const fn = (c, r, formula, value) => {
    ws[ea(c, r)] = { t: 'n', f: formula.replace(/^=/, ''), v: value };
  };

  // ── Input cell aliases (all $-absolute, column B = index 1) ─────────────
  // B3=pvPower  B4=epv  B5=pEpv_local  B6=fEpv%  B7=ep%  B8=d%  B9=n
  // B10=cpv     B11=comPct  B12=eom%  B13=useLoan  B14=ownCapPct%  B15=loanRate%  B16=loanYears
  // B20=comYr1  B21=ownCapital  B22=loanPrincipal  B23=annualLoanPayment

  // Derived Inputs: rows 19-22 (0-indexed) → Excel B20..B23
  fn(1, 19, `=$B$10*$B$11/100`,                              comYr1_v);
  fn(1, 20, `=IF($B$13,$B$14/100*$B$10,$B$10)`,             ownCap_v);
  fn(1, 21, `=IF($B$13,$B$10-$B$21,0)`,                     loanP_v);
  fn(1, 22, `=IF($B$13,PMT($B$15/100,$B$16,-$B$22),0)`,     annLoan_v);

  // Key Outputs: rows 26-31 (0-indexed) → Excel B27..B32
  fn(1, 26, `=E${er(LCOE_TOT)}/I${er(LCOE_TOT)}`,   cv(results.lcoe));   // LCOE
  fn(1, 27, `=G${er(NPV_TOT)}`,                       cv(results.npv));   // NPV
  fn(1, 30, `=$B$3*$B$4*$B$5`,                        cv(yr1Rev));         // Year-1 Revenue
  fn(1, 31, `=$B$3*$B$4`,                             params.pvPower * params.epv); // Year-1 Energy

  // ── NPV Breakdown: all data columns ──────────────────────────────────────
  // Col A(0)=Year(static), B(1)=Revenue, C(2)=Costs, D(3)=Rt-Kt, E(4)=(1+d)^t, F(5)=DiscCF, G(6)=ΣDiscCF
  const npvDS_E = er(NPV_DS), npvDE_E = er(NPV_DS + n);
  for (let i = 0; i <= n; i++) {
    const r = NPV_DS + i, rE = er(r);
    const b = results.yearlyBreakdown[i], dy = results.yearlyData[i];

    // Revenue Rt: 0 at t=0, pvPower*epv*(1-fDeg)^(t-1)*pEpv*(1+epRate)^(t-1) at t≥1
    fn(1, r, `=IF($A${rE}=0,0,$B$3*$B$4*(1-$B$6/100)^($A${rE}-1)*$B$5*(1+$B$7/100)^($A${rE}-1))`,
       cv(b.revenue));

    // Costs Kt: ownCapital at t=0, O&M*(1+eom)^(t-1) + loanPayment at t≥1
    fn(2, r, `=IF($A${rE}=0,$B$21,$B$20*(1+$B$12/100)^($A${rE}-1)+IF($A${rE}<=$B$16,$B$23,0))`,
       cv(b.costNumerator));

    fn(3, r, `=$B${rE}-$C${rE}`,                                            cv(b.cfNumerator));   // Rt-Kt
    fn(4, r, `=(1+$B$8/100)^$A${rE}`,                                       +b.cfDenominator.toFixed(6)); // (1+d)^t
    fn(5, r, `=$D${rE}/$E${rE}`,                                            cv(b.discCf));         // Disc.CF
    fn(6, r, i === 0 ? `=$F${rE}` : `=$G${er(NPV_DS+i-1)}+$F${rE}`,        cv(dy.cumNpv));        // Σ NPV
  }
  { const r = NPV_TOT;
    fn(1, r, `=SUM(B${npvDS_E}:B${npvDE_E})`, cv(tot.revenue));
    fn(2, r, `=SUM(C${npvDS_E}:C${npvDE_E})`, cv(tot.costNumerator));
    fn(3, r, `=SUM(D${npvDS_E}:D${npvDE_E})`, cv(tot.cf));
    fn(5, r, `=SUM(F${npvDS_E}:F${npvDE_E})`, cv(tot.discCf));
    fn(6, r, `=$G${npvDE_E}`,                  cv(finalNpv));
  }

  // ── LCOE Breakdown: all data columns ─────────────────────────────────────
  // A=Year, B=CostNum, C=(1+d)^t, D=DiscCost, E=ΣDiscCost, F=Energy, G=(1+d)^(t-1), H=DiscEnergy, I=ΣDiscEnergy, J=RunLCOE
  const lcoeDS_E = er(LCOE_DS), lcoeDE_E = er(LCOE_DS + n);
  for (let i = 0; i <= n; i++) {
    const r = LCOE_DS + i, rE = er(r);
    const b = results.yearlyBreakdown[i];

    // Cost Numerator (same formula as NPV Costs Kt)
    fn(1, r, `=IF($A${rE}=0,$B$21,$B$20*(1+$B$12/100)^($A${rE}-1)+IF($A${rE}<=$B$16,$B$23,0))`,
       cv(b.costNumerator));
    fn(2, r, `=(1+$B$8/100)^$A${rE}`,                                           +b.discountFactor.toFixed(6)); // (1+d)^t
    fn(3, r, `=$B${rE}/$C${rE}`,                                                cv(b.discCost));    // Disc.Cost
    fn(4, r, i === 0 ? `=$D${rE}` : `=$E${er(LCOE_DS+i-1)}+$D${rE}`,           cv(b.runningCostSum)); // Σ Disc.Cost
    fn(5, r, `=IF($A${rE}=0,0,$B$3*$B$4*(1-$B$6/100)^($A${rE}-1))`,
       b.energyNumerator > 0 ? +b.energyNumerator.toFixed(2) : 0); // Energy
    if (i > 0) {
      fn(6, r, `=(1+$B$8/100)^($A${rE}-1)`,                                     +b.energyDiscountFactor.toFixed(6)); // (1+d)^(t-1)
      fn(7, r, `=$F${rE}/$G${rE}`,                                               +b.discEnergy.toFixed(2));  // Disc.Energy
      fn(8, r, i === 1 ? `=$H${rE}` : `=$I${er(LCOE_DS+i-1)}+$H${rE}`,         +b.runningEnergySum.toFixed(2)); // Σ Disc.Energy
      const rl = b.runningEnergySum > 0 ? b.runningCostSum / b.runningEnergySum : 0;
      fn(9, r, `=$E${rE}/$I${rE}`,                                               cvLcoe(rl));        // Running LCOE
    }
  }
  { const r = LCOE_TOT, rE = er(r);
    fn(1, r, `=SUM(B${lcoeDS_E}:B${lcoeDE_E})`, cv(tot.costNumerator));
    fn(3, r, `=SUM(D${lcoeDS_E}:D${lcoeDE_E})`, cv(tot.discCost));
    fn(4, r, `=$E${lcoeDE_E}`,                   cv(tot.discCost));
    fn(5, r, `=SUM(F${lcoeDS_E}:F${lcoeDE_E})`, +tot.energy.toFixed(2));
    fn(7, r, `=SUM(H${lcoeDS_E}:H${lcoeDE_E})`, +tot.discEnergy.toFixed(2));
    fn(8, r, `=$I${lcoeDE_E}`,                   +tot.discEnergy.toFixed(2));
    fn(9, r, `=$E${rE}/$I${rE}`,                 cvLcoe(finalLcoe));
  }

  // ── Cash Flow Detail: all data columns ───────────────────────────────────
  // A=Year, B=Energy, C=Revenue, D=O&M, E=Investment, F=Loan, G=NetCF, H=DiscCF, I=CumNPV
  const cfDS_E = er(CF_DS), cfDE_E = er(CF_DS + n);
  for (let i = 0; i <= n; i++) {
    const r = CF_DS + i, rE = er(r);
    const dy = results.yearlyData[i], b = results.yearlyBreakdown[i];

    fn(1, r, `=IF($A${rE}=0,0,$B$3*$B$4*(1-$B$6/100)^($A${rE}-1))`,
       +b.energy.toFixed(2));  // Energy
    fn(2, r, `=IF($A${rE}=0,0,$B$3*$B$4*(1-$B$6/100)^($A${rE}-1)*$B$5*(1+$B$7/100)^($A${rE}-1))`,
       cv(b.revenue));  // Revenue
    fn(3, r, `=IF($A${rE}=0,0,$B$20*(1+$B$12/100)^($A${rE}-1))`,
       cv(b.omCost));   // O&M
    fn(4, r, `=IF($A${rE}=0,$B$21,0)`,                                          b.investment > 0 ? cv(b.investment) : 0); // Investment
    fn(5, r, `=IF($A${rE}=0,0,IF($A${rE}<=$B$16,$B$23,0))`,                    b.loan > 0 ? cv(b.loan) : 0); // Loan
    fn(6, r, `=$C${rE}-$D${rE}-$E${rE}-$F${rE}`,                               cv(dy.cf));    // Net CF
    // Disc.CF: Net CF ÷ (1+d)^t — reuse (1+d)^t from LCOE col C at same year offset
    fn(7, r, `=$G${rE}/$C${er(LCOE_DS+i)}`,                                     cv(b.discCf)); // Disc.CF
    fn(8, r, i === 0 ? `=$H${rE}` : `=$I${er(CF_DS+i-1)}+$H${rE}`,             cv(dy.cumNpv)); // Cum.NPV
  }
  { const r = CF_TOT;
    fn(1, r, `=SUM(B${cfDS_E}:B${cfDE_E})`, +tot.energy.toFixed(2));
    fn(2, r, `=SUM(C${cfDS_E}:C${cfDE_E})`, cv(tot.revenue));
    fn(3, r, `=SUM(D${cfDS_E}:D${cfDE_E})`, cv(tot.omCost));
    fn(4, r, `=SUM(E${cfDS_E}:E${cfDE_E})`, cv(tot.investment));
    fn(5, r, `=SUM(F${cfDS_E}:F${cfDE_E})`, cv(tot.loan));
    fn(6, r, `=SUM(G${cfDS_E}:G${cfDE_E})`, cv(tot.cf));
    fn(7, r, `=SUM(H${cfDS_E}:H${cfDE_E})`, cv(tot.discCf));
    fn(8, r, `=$I${cfDE_E}`,                 cv(finalNpv));
  }

  return ws;
}

function exportExcel(profiles, currency) {
  if (profiles.length === 0) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSummaryComparisonSheet(profiles, currency), "Summary");
  for (const profile of profiles) {
    const name = profile.name.slice(0, 31).replace(/[:\\/?\*\[\]]/g, "_");
    XLSX.utils.book_append_sheet(wb, makeProfileDetailSheet(profile.params, profile.results, currency), name);
  }
  XLSX.writeFile(wb, "PV_Calculator_Results.xlsx");
}

// ── UI Components ────────────────────────────────────────────────────────────

function Tooltip({ text }) {
  const [visible, setVisible] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
        style={{
          cursor: "help", fontSize: 11, background: "#2a3a52", borderRadius: "50%",
          width: 16, height: 16, display: "inline-flex", alignItems: "center",
          justifyContent: "center", color: "#5b9cf6", fontWeight: 700, userSelect: "none",
        }}>?</span>
      {visible && (
        <span style={{
          position: "absolute", left: "50%", bottom: "calc(100% + 6px)",
          transform: "translateX(-50%)", background: "#1a2d45", border: "1px solid #2e4a6a",
          borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#c8d9ed",
          lineHeight: 1.5, whiteSpace: "normal", width: 200, zIndex: 100,
          boxShadow: "0 4px 16px #00000066", pointerEvents: "none",
        }}>
          {text}
          <span style={{
            position: "absolute", left: "50%", top: "100%", transform: "translateX(-50%)",
            borderWidth: "5px 5px 0", borderStyle: "solid",
            borderColor: "#2e4a6a transparent transparent",
          }} />
        </span>
      )}
    </span>
  );
}

function InputField({ label, sublabel, unit, value, onChange, step = 1, min = 0, tooltip }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontSize: 13, color: "#8a9bb5", letterSpacing: "0.02em",
      }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {label}{tooltip && <Tooltip text={tooltip} />}
          </span>
          {sublabel && <span style={{ fontSize: 10, color: "#4a6080", fontStyle: "italic" }}>{sublabel}</span>}
        </span>
        {unit && <span style={{ color: "#5b7a9e", fontSize: 11 }}>{unit}</span>}
      </label>
      <input
        type="number" step={step} min={min} value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={{
          width: "100%", boxSizing: "border-box", marginTop: 4,
          padding: "9px 12px", background: "#162032", border: "1px solid #2a3f5c",
          borderRadius: 8, color: "#e2ecf7", fontSize: 14,
          fontFamily: "'JetBrains Mono', monospace", outline: "none", transition: "border-color 0.2s",
        }}
        onFocus={e => e.target.style.borderColor = "#4a90d9"}
        onBlur={e => e.target.style.borderColor = "#2a3f5c"}
      />
    </div>
  );
}

function CurrencyToggle({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", gap: 4, background: "#0c1524", borderRadius: 10, padding: 3, border: "1px solid #1e3050" }}>
      {["USD", "UZS"].map(c => (
        <button key={c} onClick={() => onChange(c)} style={{
          padding: "5px 16px", borderRadius: 7, border: "none", cursor: "pointer",
          background: value === c ? "#1e3a5c" : "transparent",
          color: value === c ? "#5b9cf6" : "#5b7a9e",
          fontWeight: value === c ? 700 : 400,
          fontSize: 13, transition: "all 0.15s",
        }}>{c}</button>
      ))}
    </div>
  );
}

function ResultCard({ label, value, unit, color, subtitle }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}18, ${color}08)`,
      border: `1px solid ${color}35`, borderRadius: 14, padding: "18px 20px",
      flex: "1 1 140px", minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: "#8a9bb5", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1 }}>
        {value}{unit && <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 4 }}>{unit}</span>}
      </div>
      {subtitle && <div style={{ fontSize: 11, color: "#6b7f9e", marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

function MiniBar({ data }) {
  if (!data || data.length === 0) return null;
  const maxVal = Math.max(...data.map(d => Math.abs(d.cumNpv)));
  const chartW = 600, chartH = 180;
  const barW = Math.max(2, (chartW - 40) / data.length - 2);
  const zero = chartH / 2;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${chartW} ${chartH + 30}`} width="100%" height={220}>
        <line x1="20" y1={zero} x2={chartW - 10} y2={zero} stroke="#2a3f5c" strokeWidth="1" />
        <text x="14" y={zero - 4} fill="#5b7a9e" fontSize="9" textAnchor="end">0</text>
        {data.map((d, i) => {
          const h = maxVal > 0 ? (d.cumNpv / maxVal) * (chartH / 2 - 10) : 0;
          const x = 24 + i * ((chartW - 40) / data.length);
          const y = d.cumNpv >= 0 ? zero - h : zero;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={Math.max(1, Math.abs(h))}
                fill={d.cumNpv >= 0 ? "#4ecdc4" : "#e85d75"} rx="1" opacity="0.85" />
              {i % Math.ceil(data.length / 10) === 0 && (
                <text x={x + barW / 2} y={chartH + 18} fill="#5b7a9e" fontSize="9" textAnchor="middle">{d.year}</text>
              )}
            </g>
          );
        })}
        <text x={chartW / 2} y={chartH + 28} fill="#5b7a9e" fontSize="9" textAnchor="middle">Year</text>
      </svg>
    </div>
  );
}

function DetailedCalculations({ params, results, currency }) {
  const rate = params.exchangeRate;
  const m = v => fmtMoney(v, currency, rate);

  // Row totals (sum over all years)
  const tot = results.yearlyBreakdown.reduce((a, b) => ({
    energy:        a.energy        + b.energy,
    revenue:       a.revenue       + b.revenue,
    omCost:        a.omCost        + b.omCost,
    investment:    a.investment    + b.investment,
    loan:          a.loan          + b.loan,
    cf:            a.cf            + b.cf,
    discCf:        a.discCf        + b.discCf,
    costNumerator: a.costNumerator + b.costNumerator,
    discCost:      a.discCost      + b.discCost,
    discEnergy:    a.discEnergy    + b.discEnergy,
  }), { energy:0, revenue:0, omCost:0, investment:0, loan:0, cf:0, discCf:0, costNumerator:0, discCost:0, discEnergy:0 });

  const finalNpv = results.yearlyData[results.yearlyData.length - 1].cumNpv;
  const finalLcoe = tot.discEnergy > 0 ? tot.discCost / tot.discEnergy : 0;

  const tfootStyle = { background: "#0e2240", borderTop: "2px solid #4a90d9" };
  const tft = { color: "#5b9cf6", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, padding: "6px 10px", textAlign: "right" };

  const th = {
    color: "#5b7a9e", fontSize: 11, fontWeight: 600,
    padding: "6px 10px", borderBottom: "1px solid #1e3050",
    textAlign: "right", whiteSpace: "nowrap",
  };
  const td = (pos) => ({
    color: pos === true ? "#4ecdc4" : pos === false ? "#e85d75" : "#c8d9ed",
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    padding: "4px 10px", borderBottom: "1px solid #162032", textAlign: "right",
  });

  const steps = [
    ["1. Total System Cost (Cpv)", `$${params.pvTotalCost.toFixed(2)} × ${rate.toLocaleString()} = ${m(results.cpv)}`],
    ["2. Annual O&M Cost (COM, Year 1)", `${params.comPercent}% × ${m(results.cpv)} = ${m((params.comPercent / 100) * results.cpv)}/yr`],
    ["3. Year-1 Energy Output", `${params.pvPower} kW × ${params.epv} kWh/kW = ${(params.pvPower * params.epv).toLocaleString()} kWh`],
    ["4. Year-1 Revenue", `${(params.pvPower * params.epv).toLocaleString()} kWh × $${params.pEpv} = ${m(params.pvPower * params.epv * params.pEpv * rate)}`],
    ["5. LCOE", fmtLcoe(results.lcoe, currency, rate)],
    ["6. NPV (lifetime)", m(results.npv)],
    ["7. IRR", `${results.irr.toFixed(2)}%  (WACC = ${params.d}%)`],
    ["8. Discounted Payback", `${results.dpbt.toFixed(1)} years of ${params.n}`],
    ...(params.useLoan ? [
      ["Own Capital", `${params.ownCapitalPercent}% × ${m(results.cpv)} = ${m(results.ownCapital)}`],
      ["Loan Principal", m(results.loanPrincipal)],
      ["Annual Loan Payment", `${m(results.annualLoanPayment)}/yr  over ${params.loanYears} yrs @ ${params.loanRate}%`],
    ] : []),
  ];

  return (
    <div style={{ marginTop: 20 }}>
      {/* Step-by-step */}
      <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Step-by-Step Calculations
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 30px" }}>
          {steps.map(([label, val], i) => (
            <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid #1a2d45" }}>
              <div style={{ fontSize: 11, color: "#5b7a9e", marginBottom: 2 }}>{label}</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#c8d9ed" }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* NPV Breakdown Table */}
      <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          NPV Breakdown ({currency})
        </div>
        <div style={{ fontSize: 11, color: "#5b7a9e", marginBottom: 10 }}>
          NPV = Σ<sub>t=0..n</sub> [ (R<sub>t</sub> − K<sub>t</sub>) / (1 + d)<sup>t</sup> ] &nbsp;|&nbsp; t=0: K<sub>0</sub>=C<sub>pv</sub>, R<sub>0</sub>=0
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Year (t)",
                  `Rₜ — Revenue (${currency})`,
                  `Kₜ — Costs (${currency})`,
                  `Rₜ − Kₜ (${currency})`,
                  "(1+d)ᵗ — Denominator",
                  `Disc. CF = (Rₜ−Kₜ)/(1+d)ᵗ (${currency})`,
                  `Σ Disc. CF = NPV (${currency})`,
                ].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.yearlyBreakdown.map((b, i) => {
                const d = results.yearlyData[i];
                return (
                  <tr key={b.t} style={{ background: i % 2 === 0 ? "#0e1a2a" : "transparent" }}>
                    <td style={{ ...td(null), color: "#5b9cf6", textAlign: "center" }}>{b.t}</td>
                    <td style={td(null)}>{m(b.revenue)}</td>
                    <td style={td(null)}>{m(b.costNumerator)}</td>
                    <td style={td(b.cfNumerator >= 0)}>{m(b.cfNumerator)}</td>
                    <td style={td(null)}>{b.cfDenominator.toFixed(4)}</td>
                    <td style={td(b.discCf >= 0)}>{m(b.discCf)}</td>
                    <td style={td(d.cumNpv >= 0)}>{m(d.cumNpv)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot style={tfootStyle}>
              <tr>
                <td style={{ ...tft, color: "#8a9bb5" }}>TOTAL</td>
                <td style={tft}>{m(tot.revenue)}</td>
                <td style={tft}>{m(tot.costNumerator)}</td>
                <td style={tft}>{m(tot.cf)}</td>
                <td style={{ ...tft, color: "#5b7a9e" }}>—</td>
                <td style={{ ...tft, color: finalNpv >= 0 ? "#4ecdc4" : "#e85d75" }}>{m(tot.discCf)}</td>
                <td style={{ ...tft, color: finalNpv >= 0 ? "#4ecdc4" : "#e85d75" }}>{m(finalNpv)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* LCOE Breakdown Table */}
      <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          LCOE Breakdown ({currency})
        </div>
        <div style={{ fontSize: 11, color: "#5b7a9e", marginBottom: 10 }}>
          LCOE = Σ [ Cost<sub>t</sub> / (1+d)<sup>t</sup> ] ÷ Σ [ Energy<sub>t</sub> / (1+d)<sup>t-1</sup> ]
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Year (t)",
                  `Cost\u209c Numerator (${currency})`,
                  "(1+d)ᵗ Cost Denom.",
                  `Disc. Cost (${currency})`,
                  `Σ Disc. Cost (${currency})`,
                  "Energy\u209c kWh",
                  "(1+d)ᵗ⁻¹ Energy Denom.",
                  "Disc. Energy kWh",
                  "Σ Disc. Energy kWh",
                  `Running LCOE (${currency}/kWh)`,
                ].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.yearlyBreakdown.map((b, i) => {
                const runningLcoe = b.runningEnergySum > 0 ? b.runningCostSum / b.runningEnergySum : null;
                return (
                  <tr key={b.t} style={{ background: i % 2 === 0 ? "#0e1a2a" : "transparent" }}>
                    <td style={{ ...td(null), color: "#5b9cf6", textAlign: "center" }}>{b.t}</td>
                    <td style={td(null)}>{m(b.costNumerator)}</td>
                    <td style={td(null)}>{b.discountFactor.toFixed(4)}</td>
                    <td style={td(null)}>{m(b.discCost)}</td>
                    <td style={td(null)}>{m(b.runningCostSum)}</td>
                    <td style={td(null)}>{b.energyNumerator > 0 ? b.energyNumerator.toFixed(1) : "—"}</td>
                    <td style={td(null)}>{b.t === 0 ? "—" : b.energyDiscountFactor.toFixed(4)}</td>
                    <td style={td(null)}>{b.discEnergy > 0 ? b.discEnergy.toFixed(1) : "—"}</td>
                    <td style={td(null)}>{b.runningEnergySum > 0 ? b.runningEnergySum.toFixed(1) : "—"}</td>
                    <td style={{ ...td(null), color: "#4ecdc4" }}>{runningLcoe !== null ? fmtLcoe(runningLcoe, currency, rate) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot style={tfootStyle}>
              <tr>
                <td style={{ ...tft, color: "#8a9bb5" }}>TOTAL</td>
                <td style={tft}>{m(tot.costNumerator)}</td>
                <td style={{ ...tft, color: "#5b7a9e" }}>—</td>
                <td style={tft}>{m(tot.discCost)}</td>
                <td style={{ ...tft, color: "#4ecdc4" }}>{m(tot.discCost)}</td>
                <td style={tft}>{tot.energy.toFixed(1)}</td>
                <td style={{ ...tft, color: "#5b7a9e" }}>—</td>
                <td style={tft}>{tot.discEnergy.toFixed(1)}</td>
                <td style={{ ...tft, color: "#4ecdc4" }}>{tot.discEnergy.toFixed(1)}</td>
                <td style={{ ...tft, color: "#4ecdc4" }}>{fmtLcoe(finalLcoe, currency, rate)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Cash Flow Detail Table */}
      <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Cash Flow Detail ({currency})
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Year", "Energy (kWh)", "Revenue", "O&M Cost", "Investment", "Loan Pmt", "Net Cash Flow", "Disc. Cash Flow", "Cum. NPV"].map(h => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.yearlyBreakdown.map((b, i) => {
                const d = results.yearlyData[i];
                return (
                  <tr key={b.t} style={{ background: i % 2 === 0 ? "#0e1a2a" : "transparent" }}>
                    <td style={{ ...td(null), color: "#5b9cf6", textAlign: "center" }}>{b.t}</td>
                    <td style={td(null)}>{b.energy.toFixed(0)}</td>
                    <td style={td(null)}>{m(b.revenue)}</td>
                    <td style={td(null)}>{m(b.omCost)}</td>
                    <td style={td(null)}>{b.investment > 0 ? m(b.investment) : "—"}</td>
                    <td style={td(null)}>{b.loan > 0 ? m(b.loan) : "—"}</td>
                    <td style={td(d.cf >= 0)}>{m(d.cf)}</td>
                    <td style={td(b.discCf >= 0)}>{m(b.discCf)}</td>
                    <td style={td(d.cumNpv >= 0)}>{m(d.cumNpv)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot style={tfootStyle}>
              <tr>
                <td style={{ ...tft, color: "#8a9bb5" }}>TOTAL</td>
                <td style={tft}>{tot.energy.toFixed(0)}</td>
                <td style={tft}>{m(tot.revenue)}</td>
                <td style={tft}>{m(tot.omCost)}</td>
                <td style={tft}>{m(tot.investment)}</td>
                <td style={tft}>{tot.loan > 0 ? m(tot.loan) : "—"}</td>
                <td style={{ ...tft, color: tot.cf >= 0 ? "#4ecdc4" : "#e85d75" }}>{m(tot.cf)}</td>
                <td style={{ ...tft, color: tot.discCf >= 0 ? "#4ecdc4" : "#e85d75" }}>{m(tot.discCf)}</td>
                <td style={{ ...tft, color: finalNpv >= 0 ? "#4ecdc4" : "#e85d75" }}>{m(finalNpv)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function PVCalculator() {
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [currency, setCurrency] = useState("USD");
  const [showDetails, setShowDetails] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [profileName, setProfileName] = useState("Profile 1");
  const update = useCallback((key, val) => setParams(prev => ({ ...prev, [key]: val })), []);
  const results = useMemo(() => calculate(params), [params]);

  const saveProfile = useCallback(() => {
    const name = profileName.trim() || `Profile ${profiles.length + 1}`;
    setProfiles(prev => [...prev, { id: Date.now(), name, params: { ...params }, results }]);
    setProfileName(`Profile ${profiles.length + 2}`);
  }, [profileName, params, results, profiles.length]);

  const deleteProfile = useCallback((id) => {
    setProfiles(prev => prev.filter(p => p.id !== id));
  }, []);

  const loadProfile = useCallback((profile) => {
    setParams(profile.params);
    setProfileName(profile.name);
  }, []);

  const rate = params.exchangeRate;
  const m = v => fmtMoney(v, currency, rate);
  const lcoeDisplay = fmtLcoe(results.lcoe, currency, rate);
  const gridPriceUzs = params.pEpv * rate;
  const gridParity = results.lcoe < gridPriceUzs;

  const summaryRows = [
    ["Total System Cost", results.cpv],
    ["Own Capital", results.ownCapital],
    ...(params.useLoan ? [
      ["Loan Amount", results.loanPrincipal],
      ["Annual Loan Payment", results.annualLoanPayment],
    ] : []),
    ["Year-1 Revenue", params.pvPower * params.epv * params.pEpv * rate],
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0c1524", color: "#c8d9ed", padding: "24px 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 28, textAlign: "center" }}>
          <div style={{
            display: "inline-block", padding: "4px 14px", borderRadius: 20,
            background: "#1a2d45", border: "1px solid #2a3f5c",
            fontSize: 11, color: "#5b9cf6", letterSpacing: "0.06em",
            textTransform: "uppercase", marginBottom: 10,
          }}>PV Financial Analysis Tool</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "#e8f1fa", margin: "0 0 10px" }}>
            Solar PV Investment Calculator
          </h1>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <CurrencyToggle value={currency} onChange={setCurrency} />
            <button
              onClick={() => exportExcel(
                profiles.length > 0 ? profiles : [{ id: 0, name: "Current", params, results }],
                currency
              )}
              style={{
                padding: "6px 18px", borderRadius: 9, border: "1px solid #2a5c2a",
                background: "#0e2a0e", color: "#4ecdc4", fontSize: 13,
                fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.target.style.background = "#143a14"; e.target.style.borderColor = "#4ecdc4"; }}
              onMouseLeave={e => { e.target.style.background = "#0e2a0e"; e.target.style.borderColor = "#2a5c2a"; }}
            >
              ↓ Download Excel{profiles.length > 0 ? ` (${profiles.length})` : ""}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", gap: 20, alignItems: "start" }}>
          {/* Inputs Panel */}
          <div style={{
            background: "#111e30", border: "1px solid #1e3050",
            borderRadius: 16, padding: 20, maxHeight: "88vh", overflowY: "auto",
          }}>
            {/* Profiles Section */}
            <div style={{ background: "#0e1a2a", border: "1px solid #1e3050", borderRadius: 10, padding: "12px 14px", marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: "#5b9cf6", fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Profiles</span>
                {profiles.length > 0 && <span style={{ color: "#4ecdc4", fontWeight: 700 }}>{profiles.length} saved</span>}
              </div>
              {profiles.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {profiles.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #1a2d45" }}>
                      <span style={{ fontSize: 12, color: "#c8d9ed", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{p.name}</span>
                      <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                        <button onClick={() => loadProfile(p)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid #2a4060", background: "#162032", color: "#5b9cf6", cursor: "pointer" }}>Load</button>
                        <button onClick={() => deleteProfile(p.id)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "1px solid #3a2020", background: "#1e0e0e", color: "#e85d75", cursor: "pointer" }}>×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={profileName}
                  onChange={e => setProfileName(e.target.value)}
                  placeholder="Profile name..."
                  style={{ flex: 1, padding: "6px 10px", background: "#162032", border: "1px solid #2a3f5c", borderRadius: 6, color: "#e2ecf7", fontSize: 12, outline: "none", minWidth: 0 }}
                  onFocus={e => e.target.style.borderColor = "#4a90d9"}
                  onBlur={e => e.target.style.borderColor = "#2a3f5c"}
                />
                <button onClick={saveProfile} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #2a5c2a", background: "#0e2a0e", color: "#4ecdc4", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
                  Save
                </button>
              </div>
            </div>

            <div style={{ background: "#0e2240", border: "1px solid #1e4070", borderRadius: 10, padding: "12px 14px", marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: "#5b9cf6", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Exchange Rate
              </div>
              <InputField label="1 USD =" unit="UZS" value={params.exchangeRate}
                onChange={v => update("exchangeRate", v)} step={50}
                tooltip="Set current USD to UZS exchange rate" />
              <div style={{ fontSize: 11, color: "#5b7a9e", marginTop: -6 }}>
                1 UZS = ${(1 / rate).toFixed(6)} USD
              </div>
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              System Parameters
            </div>
            <InputField label="PV Power" sublabel="capacity (kW)" unit="kW" value={params.pvPower} onChange={v => update("pvPower", v)} step={5} tooltip="Installed PV capacity in kilowatts" />
            <InputField label="Total PV Cost" sublabel="Cpv (USD)" unit="USD" value={params.pvTotalCost} onChange={v => update("pvTotalCost", v)} step={100} tooltip="Total capital cost of the PV system in USD" />
            <InputField label="O&M Cost" sublabel="COM (% of Cpv/yr)" unit="% of Cpv/yr" value={params.comPercent} onChange={v => update("comPercent", v)} step={0.1} tooltip="Annual O&M cost as % of total system cost" />
            <InputField label="O&M Escalation" sublabel="EOM (%/yr)" unit="%/yr" value={params.eom} onChange={v => update("eom", v)} step={0.1} tooltip="Annual escalation rate of O&M costs" />
            <InputField label="Annual PV Yield" sublabel="EPV (kWh/kW/yr)" unit="kWh/kW/yr" value={params.epv} onChange={v => update("epv", v)} step={10} tooltip="Annual electricity production per kW" />
            <InputField label="Degradation Factor" sublabel="fEPV (%/yr)" unit="%/yr" value={params.fEpv} onChange={v => update("fEpv", v)} step={0.1} tooltip="Annual panel efficiency degradation" />

            <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", margin: "18px 0 14px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Financial Parameters
            </div>
            <InputField label="Electricity Price" sublabel="P(EPV) (USD/kWh)" unit="USD/kWh" value={params.pEpv} onChange={v => update("pEpv", v)} step={0.001} tooltip="Current retail electricity price in USD" />
            <InputField label="Electricity Price Increase" sublabel="ΔP (%/yr)" unit="%/yr" value={params.ep} onChange={v => update("ep", v)} step={0.1} tooltip="Annual real increase in electricity price" />
            <InputField label="Discount Rate (WACC)" sublabel="d (%)" unit="%" value={params.d} onChange={v => update("d", v)} step={0.5} tooltip="Weighted average cost of capital" />
            <InputField label="System Lifetime" sublabel="n (years)" unit="years" value={params.n} onChange={v => update("n", v)} step={1} tooltip="Serviceable life of PV system" />

            {/* Loan Toggle */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", borderRadius: 10, marginBottom: 14,
              background: params.useLoan ? "#0e2240" : "#111e30",
              border: `1px solid ${params.useLoan ? "#1e4070" : "#1e3050"}`,
              transition: "all 0.2s",
            }}>
              <div>
                <div style={{ fontSize: 13, color: "#c8d9ed", fontWeight: 500 }}>Bank Loan</div>
                <div style={{ fontSize: 10, color: "#4a6080", fontStyle: "italic" }}>
                  {params.useLoan ? "Part-financed by loan" : "100% own capital"}
                </div>
              </div>
              <div onClick={() => update("useLoan", !params.useLoan)} style={{
                width: 42, height: 24, borderRadius: 12, cursor: "pointer",
                background: params.useLoan ? "#4a90d9" : "#2a3f5c",
                position: "relative", transition: "background 0.2s", flexShrink: 0,
              }}>
                <div style={{
                  position: "absolute", top: 3, left: params.useLoan ? 20 : 3,
                  width: 18, height: 18, borderRadius: "50%",
                  background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px #00000055",
                }} />
              </div>
            </div>
            {params.useLoan && (
              <>
                <InputField label="Own Capital" sublabel="own capital (%)" unit="%" value={params.ownCapitalPercent} onChange={v => update("ownCapitalPercent", v)} step={5} tooltip="Percentage financed with own capital" />
                <InputField label="Loan Period" sublabel="loan years" unit="years" value={params.loanYears} onChange={v => update("loanYears", v)} step={1} tooltip="Bank loan depreciation period" />
                <InputField label="Loan Interest Rate" sublabel="loan rate (%/yr)" unit="%/yr" value={params.loanRate} onChange={v => update("loanRate", v)} step={0.25} tooltip="Annual interest rate on bank loan" />
              </>
            )}
          </div>

          {/* Results Panel */}
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
              <ResultCard label="LCOE" value={lcoeDisplay} color="#4ecdc4"
                subtitle={gridParity ? "✓ Grid parity reached" : "✗ Above grid price"} />
              <ResultCard label="NPV" value={m(results.npv)} color={results.npv >= 0 ? "#5b9cf6" : "#e85d75"}
                subtitle={results.npv >= 0 ? "Profitable" : "Loss"} />
              <ResultCard label="IRR" value={results.irr.toFixed(1)} unit="%" color="#f0a535"
                subtitle={results.irr > params.d ? `Above WACC (${params.d}%)` : "Below WACC"} />
              <ResultCard label="DPBT" value={results.dpbt.toFixed(1)} unit="yrs" color="#c084fc"
                subtitle={`of ${params.n} yr lifetime`} />
            </div>

            {/* Grid Parity */}
            <div style={{
              background: gridParity ? "#4ecdc418" : "#e85d7518",
              border: `1px solid ${gridParity ? "#4ecdc435" : "#e85d7535"}`,
              borderRadius: 12, padding: "14px 18px", marginBottom: 16,
              display: "flex", alignItems: "center", gap: 12,
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: "50%",
                background: gridParity ? "#4ecdc425" : "#e85d7525",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
              }}>
                {gridParity ? "☀" : "⚡"}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: gridParity ? "#4ecdc4" : "#e85d75" }}>
                  {gridParity ? "Grid Parity Achieved" : "Grid Parity Not Reached"}
                </div>
                <div style={{ fontSize: 12, color: "#6b7f9e" }}>
                  LCOE {lcoeDisplay} vs Grid {fmtLcoe(gridPriceUzs, currency, rate)}
                  {" "}({gridParity ? "saving" : "costing"} {Math.abs((gridPriceUzs - results.lcoe) * 100 / gridPriceUzs).toFixed(1)}% {gridParity ? "less" : "more"})
                </div>
              </div>
            </div>

            {/* Investment Summary */}
            <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Investment Summary ({currency})
              </div>
              <div style={{ fontSize: 12 }}>
                {summaryRows.map(([label, uzs], i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #1a2d45" }}>
                    <span style={{ color: "#6b7f9e" }}>{label}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#c8d9ed" }}>{m(uzs)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                  <span style={{ color: "#6b7f9e" }}>Year-1 Energy Output</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#c8d9ed" }}>
                    {(params.pvPower * params.epv).toLocaleString()} kWh
                  </span>
                </div>
              </div>
            </div>

            {/* Chart */}
            <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Cumulative Discounted Cash Flow
              </div>
              <div style={{ fontSize: 11, color: "#5b7a9e", marginBottom: 8 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: "#4ecdc4", borderRadius: 2, marginRight: 4 }} />Positive
                <span style={{ display: "inline-block", width: 10, height: 10, background: "#e85d75", borderRadius: 2, marginLeft: 12, marginRight: 4 }} />Negative
              </div>
              <MiniBar data={results.yearlyData} />
            </div>
          </div>
        </div>

        {/* Detailed Calculations Toggle */}
        <div style={{ textAlign: "center", marginTop: 24 }}>
          <button onClick={() => setShowDetails(v => !v)} style={{
            padding: "10px 28px", borderRadius: 10, cursor: "pointer",
            background: showDetails ? "#1a2d45" : "#162032",
            border: `1px solid ${showDetails ? "#4a90d9" : "#2a3f5c"}`,
            color: showDetails ? "#5b9cf6" : "#8a9bb5",
            fontSize: 13, fontWeight: 600, transition: "all 0.2s",
          }}>
            {showDetails ? "▲ Hide Detailed Calculations" : "▼ Show Detailed Calculations"}
          </button>
        </div>

        {showDetails && <DetailedCalculations params={params} results={results} currency={currency} />}

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "#3a5070" }}>
          Methodology: Squatrito, Sgroi, Tudisca, Di Trapani & Testa — Energies 2014, 7, 7147–7165
        </div>
      </div>
    </div>
  );
}
