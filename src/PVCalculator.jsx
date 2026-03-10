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

function makeSummarySheet(params, results, currency) {
  const rate = params.exchangeRate;
  const isUsd = currency === "USD";
  const sym = isUsd ? "USD" : "UZS";
  const cv = v => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);  // convert UZS → display currency
  const yr1Rev = params.pvPower * params.epv * params.pEpv * rate;

  const rows = [
    [`SOLAR PV INVESTMENT CALCULATOR — SUMMARY (${sym})`],
    [],
    ["INPUTS", "VALUE", "UNIT"],
    ["PV Power", params.pvPower, "kW"],
    ["Total PV Cost", isUsd ? params.pvTotalCost : +(params.pvTotalCost * rate).toFixed(0), sym],
    ["O&M Cost", params.comPercent, "% of Cpv/yr"],
    ["O&M Escalation", params.eom, "%/yr"],
    ["Annual PV Yield", params.epv, "kWh/kW/yr"],
    ["Degradation Factor", params.fEpv, "%/yr"],
    ["Electricity Price", isUsd ? params.pEpv : +(params.pEpv * rate).toFixed(2), `${sym}/kWh`],
    ["Electricity Price Increase", params.ep, "%/yr"],
    ["Discount Rate (WACC)", params.d, "%"],
    ["System Lifetime", params.n, "years"],
    ["Exchange Rate", rate, "UZS per USD"],
    ["Financing", params.useLoan ? "Loan + Own Capital" : "100% Own Capital", ""],
    ...(params.useLoan ? [
      ["Own Capital", params.ownCapitalPercent, "%"],
      ["Loan Period", params.loanYears, "years"],
      ["Loan Interest Rate", params.loanRate, "%/yr"],
    ] : []),
    [],
    ["RESULTS", `VALUE (${sym})`, "UNIT"],
    ["Total System Cost (Cpv)", cv(results.cpv), sym],
    ["Own Capital", cv(results.ownCapital), sym],
    ...(params.useLoan ? [
      ["Loan Principal", cv(results.loanPrincipal), sym],
      ["Annual Loan Payment", cv(results.annualLoanPayment), sym],
    ] : []),
    ["LCOE", cv(results.lcoe), `${sym}/kWh`],
    ["NPV", cv(results.npv), sym],
    ["IRR", +results.irr.toFixed(2), "%"],
    ["DPBT", +results.dpbt.toFixed(1), "years"],
    ["Year-1 Revenue", cv(yr1Rev), sym],
    ["Year-1 Energy Output", params.pvPower * params.epv, "kWh"],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 28 }, { wch: 18 }, { wch: 14 }];
  return ws;
}

function makeCashFlowSheet(params, results, currency) {
  const rate = params.exchangeRate;
  const isUsd = currency === "USD";
  const sym = currency;
  const cv = v => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);

  const header = [
    "Year", "Energy (kWh)",
    `Revenue (${sym})`, `O&M Cost (${sym})`,
    `Investment (${sym})`, `Loan Payment (${sym})`,
    `Net Cash Flow (${sym})`, `Disc. Cash Flow (${sym})`, `Cum. NPV (${sym})`,
  ];

  const dataRows = results.yearlyData.map((d, i) => {
    const b = results.yearlyBreakdown[i];
    return [
      d.year,
      +b.energy.toFixed(2),
      cv(b.revenue),
      cv(b.omCost),
      b.investment > 0 ? cv(b.investment) : 0,
      b.loan > 0 ? cv(b.loan) : 0,
      cv(d.cf),
      cv(b.discCf),
      cv(d.cumNpv),
    ];
  });

  const tot = results.yearlyBreakdown.reduce((a, b) => ({
    energy: a.energy + b.energy, revenue: a.revenue + b.revenue,
    omCost: a.omCost + b.omCost, investment: a.investment + b.investment,
    loan: a.loan + b.loan, cf: a.cf + b.cf, discCf: a.discCf + b.discCf,
  }), { energy:0, revenue:0, omCost:0, investment:0, loan:0, cf:0, discCf:0 });
  const finalNpv = results.yearlyData[results.yearlyData.length - 1].cumNpv;
  const totalRow = [
    "TOTAL", +tot.energy.toFixed(2), cv(tot.revenue), cv(tot.omCost),
    cv(tot.investment), cv(tot.loan), cv(tot.cf), cv(tot.discCf), cv(finalNpv),
  ];

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows, [], totalRow]);
  ws["!cols"] = header.map(() => ({ wch: 20 }));
  return ws;
}

function makeNpvSheet(params, results, currency) {
  const rate = params.exchangeRate;
  const isUsd = currency === "USD";
  const sym = currency;
  const cv = v => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);

  const header = [
    "Year (t)",
    `R\u209c — Revenue (${sym})`,
    `K\u209c — Costs (${sym})`,
    `R\u209c - K\u209c (${sym})`,
    "(1+d)^t — Denominator",
    `Disc. CF = (Rt-Kt)/(1+d)^t (${sym})`,
    `\u03A3 Disc. CF = NPV (${sym})`,
  ];

  const dataRows = results.yearlyBreakdown.map((b, i) => {
    const d = results.yearlyData[i];
    return [b.t, cv(b.revenue), cv(b.costNumerator), cv(b.cfNumerator), +b.cfDenominator.toFixed(6), cv(b.discCf), cv(d.cumNpv)];
  });

  const totCf = results.yearlyBreakdown.reduce((a, b) => ({
    revenue: a.revenue + b.revenue,
    cost: a.cost + b.costNumerator,
    cf: a.cf + b.cf,
    discCf: a.discCf + b.discCf,
  }), { revenue: 0, cost: 0, cf: 0, discCf: 0 });
  const finalNpv = results.yearlyData[results.yearlyData.length - 1].cumNpv;
  const totalRow = ["TOTAL", cv(totCf.revenue), cv(totCf.cost), cv(totCf.cf), "—", cv(totCf.discCf), cv(finalNpv)];

  const ws = XLSX.utils.aoa_to_sheet([
    [`NPV = \u03A3(t=0..n) [ (Rt - Kt) / (1 + d)^t ]   |   d = ${params.d}%   |   t=0: K0=Cpv, R0=0`],
    [],
    header,
    ...dataRows,
    [],
    totalRow,
  ]);
  ws["!cols"] = header.map(() => ({ wch: 24 }));
  return ws;
}

function makeLcoeSheet(params, results, currency) {
  const rate = params.exchangeRate;
  const isUsd = currency === "USD";
  const sym = currency;
  const cv = v => isUsd ? +(v / rate).toFixed(2) : +v.toFixed(0);
  const cvLcoe = v => isUsd ? +(v / rate).toFixed(6) : +v.toFixed(4);

  const header = [
    "Year (t)",
    `Cost\u209c Numerator (${sym})`,
    "(1+d)^t Cost Denom.",
    `Disc. Cost (${sym})`,
    `\u03A3 Disc. Cost (${sym})`,
    "Energy\u209c (kWh)",
    "(1+d)^(t-1) Energy Denom.",
    "Disc. Energy (kWh)",
    "\u03A3 Disc. Energy (kWh)",
    `Running LCOE (${sym}/kWh)`,
  ];

  const dataRows = results.yearlyBreakdown.map(b => {
    const runningLcoe = b.runningEnergySum > 0 ? b.runningCostSum / b.runningEnergySum : null;
    return [
      b.t, cv(b.costNumerator), +b.discountFactor.toFixed(6),
      cv(b.discCost), cv(b.runningCostSum),
      b.energyNumerator > 0 ? +b.energyNumerator.toFixed(2) : "—",
      b.t === 0 ? "—" : +b.energyDiscountFactor.toFixed(6),
      b.discEnergy > 0 ? +b.discEnergy.toFixed(2) : "—",
      b.runningEnergySum > 0 ? +b.runningEnergySum.toFixed(2) : "—",
      runningLcoe !== null ? cvLcoe(runningLcoe) : "—",
    ];
  });

  const last = results.yearlyBreakdown[results.yearlyBreakdown.length - 1];
  const totCostNum = results.yearlyBreakdown.reduce((a, b) => a + b.costNumerator, 0);
  const finalLcoe = last.runningEnergySum > 0 ? last.runningCostSum / last.runningEnergySum : 0;
  const totalRow = [
    "TOTAL", cv(totCostNum), "—",
    cv(last.runningCostSum), cv(last.runningCostSum),
    +last.runningEnergySum.toFixed(2), "—", "—",
    +last.runningEnergySum.toFixed(2), cvLcoe(finalLcoe),
  ];

  const ws = XLSX.utils.aoa_to_sheet([
    [`LCOE = \u03A3[Cost\u209c/(1+d)^t] \u00F7 \u03A3[Energy\u209c/(1+d)^(t-1)]   |   d = ${params.d}%`],
    [],
    header,
    ...dataRows,
    [],
    totalRow,
  ]);
  ws["!cols"] = header.map(() => ({ wch: 22 }));
  return ws;
}

function exportExcel(params, results) {
  const wb = XLSX.utils.book_new();
  for (const cur of ["USD", "UZS"]) {
    XLSX.utils.book_append_sheet(wb, makeSummarySheet(params, results, cur), `Summary (${cur})`);
    XLSX.utils.book_append_sheet(wb, makeCashFlowSheet(params, results, cur), `Cash Flow (${cur})`);
    XLSX.utils.book_append_sheet(wb, makeNpvSheet(params, results, cur), `NPV Breakdown (${cur})`);
    XLSX.utils.book_append_sheet(wb, makeLcoeSheet(params, results, cur), `LCOE Breakdown (${cur})`);
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
  const update = useCallback((key, val) => setParams(prev => ({ ...prev, [key]: val })), []);
  const results = useMemo(() => calculate(params), [params]);

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
              onClick={() => exportExcel(params, results)}
              style={{
                padding: "6px 18px", borderRadius: 9, border: "1px solid #2a5c2a",
                background: "#0e2a0e", color: "#4ecdc4", fontSize: 13,
                fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.target.style.background = "#143a14"; e.target.style.borderColor = "#4ecdc4"; }}
              onMouseLeave={e => { e.target.style.background = "#0e2a0e"; e.target.style.borderColor = "#2a5c2a"; }}
            >
              ↓ Download Excel
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", gap: 20, alignItems: "start" }}>
          {/* Inputs Panel */}
          <div style={{
            background: "#111e30", border: "1px solid #1e3050",
            borderRadius: 16, padding: 20, maxHeight: "88vh", overflowY: "auto",
          }}>
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
