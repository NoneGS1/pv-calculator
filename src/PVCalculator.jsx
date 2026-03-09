import { useState, useCallback, useMemo } from "react";

const DEFAULT_PARAMS = {
  pvPower: 50,
  pvUnitCost: 2_370_000,   // UZS/kW (≈ $186 * 12,750)
  comPercent: 1.0,
  eom: 2.7,
  epv: 1510,
  fEpv: 0.5,
  pEpv: 2300,              // UZS/kWh
  ep: 2.2,
  d: 7.5,
  n: 25,
  ownCapitalPercent: 25,
  loanYears: 15,
  loanRate: 4.0,
  exchangeRate: 12750,     // 1 USD = 12,750 UZS
};

function computeLoanPayment(principal, annualRate, years) {
  if (annualRate === 0) return principal / years;
  const r = annualRate / 100;
  return (principal * r) / (1 - Math.pow(1 + r, -years));
}

function calculate(p) {
  const cpv = p.pvPower * p.pvUnitCost;
  const com = (p.comPercent / 100) * cpv;
  const ownCapital = (p.ownCapitalPercent / 100) * cpv;
  const loanPrincipal = cpv - ownCapital;
  const annualLoanPayment = computeLoanPayment(loanPrincipal, p.loanRate, p.loanYears);
  const dRate = p.d / 100;
  const fDeg = p.fEpv / 100;
  const eomRate = p.eom / 100;
  const epRate = p.ep / 100;

  let costSum = 0;
  let energySum = 0;
  for (let t = 0; t <= p.n; t++) {
    const omCost = com * Math.pow(1 + eomRate, Math.max(t - 1, 0));
    let annualCost;
    if (t === 0) {
      annualCost = ownCapital;
    } else if (t <= p.loanYears) {
      annualCost = annualLoanPayment + omCost;
    } else {
      annualCost = omCost;
    }
    costSum += annualCost / Math.pow(1 + dRate, t);
    if (t >= 1) {
      const energy = p.pvPower * p.epv * Math.pow(1 - fDeg, t - 1);
      energySum += energy / Math.pow(1 + dRate, t - 1);
    }
  }
  const lcoe = energySum > 0 ? costSum / energySum : 0;

  const cashFlows = [-ownCapital];
  for (let t = 1; t <= p.n; t++) {
    const energy = p.pvPower * p.epv * Math.pow(1 - fDeg, t - 1);
    const revenue = energy * p.pEpv * Math.pow(1 + epRate, t - 1);
    const omCost = com * Math.pow(1 + eomRate, t - 1);
    const loan = t <= p.loanYears ? annualLoanPayment : 0;
    cashFlows.push(revenue - omCost - loan);
  }

  let npv = 0;
  for (let t = 0; t < cashFlows.length; t++)
    npv += cashFlows[t] / Math.pow(1 + dRate, t);

  let irrLow = -0.5, irrHigh = 5.0, irr = 0;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (irrLow + irrHigh) / 2;
    let npvTest = 0;
    for (let t = 0; t < cashFlows.length; t++)
      npvTest += cashFlows[t] / Math.pow(1 + mid, t);
    if (npvTest > 0) irrLow = mid; else irrHigh = mid;
    irr = mid;
  }

  let cumulative = 0, dpbt = p.n;
  for (let t = 0; t < cashFlows.length; t++) {
    cumulative += cashFlows[t] / Math.pow(1 + dRate, t);
    if (cumulative >= 0 && t > 0) {
      const prevCum = cumulative - cashFlows[t] / Math.pow(1 + dRate, t);
      dpbt = t - 1 + (-prevCum / (cashFlows[t] / Math.pow(1 + dRate, t)));
      break;
    }
  }

  const yearlyData = [];
  let cumNpv = 0;
  for (let t = 0; t < cashFlows.length; t++) {
    cumNpv += cashFlows[t] / Math.pow(1 + dRate, t);
    yearlyData.push({ year: t, cf: cashFlows[t], cumNpv });
  }

  return { cpv, lcoe, npv, irr: irr * 100, dpbt, annualLoanPayment, ownCapital, loanPrincipal, yearlyData, cashFlows };
}

function fmtUzs(val) {
  if (Math.abs(val) >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(0)}K`;
  return val.toFixed(0);
}

function fmtUsd(val) {
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toFixed(0);
}

function InputField({ label, unit, value, onChange, step = 1, min = 0, tooltip }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontSize: 13, color: "#8a9bb5", fontFamily: "'DM Sans', sans-serif",
        letterSpacing: "0.02em",
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {label}
          {tooltip && (
            <span title={tooltip} style={{
              cursor: "help", fontSize: 11, background: "#2a3a52",
              borderRadius: "50%", width: 16, height: 16, display: "inline-flex",
              alignItems: "center", justifyContent: "center", color: "#5b9cf6",
              fontWeight: 700,
            }}>?</span>
          )}
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
          fontFamily: "'JetBrains Mono', monospace", outline: "none",
          transition: "border-color 0.2s",
        }}
        onFocus={e => e.target.style.borderColor = "#4a90d9"}
        onBlur={e => e.target.style.borderColor = "#2a3f5c"}
      />
    </div>
  );
}

function ResultCard({ label, uzsValue, usdValue, unit, color, subtitle }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}18, ${color}08)`,
      border: `1px solid ${color}35`,
      borderRadius: 14, padding: "18px 20px",
      flex: "1 1 140px", minWidth: 140,
    }}>
      <div style={{
        fontSize: 11, color: "#8a9bb5", textTransform: "uppercase",
        letterSpacing: "0.08em", fontFamily: "'DM Sans', sans-serif", marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontSize: 24, fontWeight: 700, color,
        fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1,
      }}>
        {uzsValue}<span style={{ fontSize: 12, opacity: 0.7, marginLeft: 4 }}>{unit ? unit : "UZS"}</span>
      </div>
      {usdValue !== undefined && (
        <div style={{ fontSize: 12, color: "#8a9bb5", marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
          ≈ ${usdValue} <span style={{ opacity: 0.6 }}>USD</span>
        </div>
      )}
      {subtitle && <div style={{ fontSize: 11, color: "#6b7f9e", marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

function MiniBar({ data, width = "100%", height = 220 }) {
  if (!data || data.length === 0) return null;
  const maxVal = Math.max(...data.map(d => Math.abs(d.cumNpv)));
  const chartW = 600, chartH = 180;
  const barW = Math.max(2, (chartW - 40) / data.length - 2);
  const zero = chartH / 2;
  return (
    <div style={{ width, overflowX: "auto" }}>
      <svg viewBox={`0 0 ${chartW} ${chartH + 30}`} width="100%" height={height}>
        <line x1="20" y1={zero} x2={chartW - 10} y2={zero} stroke="#2a3f5c" strokeWidth="1" />
        <text x="14" y={zero - 4} fill="#5b7a9e" fontSize="9" fontFamily="'DM Sans', sans-serif" textAnchor="end">0</text>
        {data.map((d, i) => {
          const h = maxVal > 0 ? (d.cumNpv / maxVal) * (chartH / 2 - 10) : 0;
          const x = 24 + i * ((chartW - 40) / data.length);
          const y = d.cumNpv >= 0 ? zero - h : zero;
          const fill = d.cumNpv >= 0 ? "#4ecdc4" : "#e85d75";
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={Math.max(1, Math.abs(h))} fill={fill} rx="1" opacity="0.85" />
              {i % Math.ceil(data.length / 10) === 0 && (
                <text x={x + barW / 2} y={chartH + 18} fill="#5b7a9e" fontSize="9" textAnchor="middle" fontFamily="'DM Sans', sans-serif">
                  {d.year}
                </text>
              )}
            </g>
          );
        })}
        <text x={chartW / 2} y={chartH + 28} fill="#5b7a9e" fontSize="9" textAnchor="middle" fontFamily="'DM Sans', sans-serif">Year</text>
      </svg>
    </div>
  );
}

export default function PVCalculator() {
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const update = useCallback((key, val) => setParams(prev => ({ ...prev, [key]: val })), []);
  const results = useMemo(() => calculate(params), [params]);
  const rate = params.exchangeRate;
  const gridParity = results.lcoe < params.pEpv;

  return (
    <div style={{
      minHeight: "100vh", background: "#0c1524",
      fontFamily: "'DM Sans', sans-serif", color: "#c8d9ed", padding: "24px 16px",
    }}>
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
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "#e8f1fa", margin: "0 0 6px" }}>
            Solar PV Investment Calculator
          </h1>
          <p style={{ fontSize: 13, color: "#6b7f9e", margin: 0 }}>
            LCOE, NPV, IRR & DPBT — results shown in UZS and USD
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", gap: 20, alignItems: "start" }}>
          {/* Inputs Panel */}
          <div style={{
            background: "#111e30", border: "1px solid #1e3050",
            borderRadius: 16, padding: 20, maxHeight: "88vh", overflowY: "auto",
          }}>
            {/* Exchange Rate box */}
            <div style={{
              background: "#0e2240", border: "1px solid #1e4070",
              borderRadius: 10, padding: "12px 14px", marginBottom: 18,
            }}>
              <div style={{ fontSize: 12, color: "#5b9cf6", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Exchange Rate
              </div>
              <InputField
                label="1 USD ="
                unit="UZS"
                value={params.exchangeRate}
                onChange={v => update("exchangeRate", v)}
                step={50}
                tooltip="Set current USD to UZS exchange rate"
              />
              <div style={{ fontSize: 11, color: "#5b7a9e", marginTop: -6 }}>
                1 UZS = ${(1 / rate).toFixed(6)} USD
              </div>
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              System Parameters
            </div>
            <InputField label="PV Power" unit="kW" value={params.pvPower} onChange={v => update("pvPower", v)} step={5} tooltip="Installed PV capacity in kilowatts" />
            <InputField label="PV Unit Cost" unit="UZS/kW" value={params.pvUnitCost} onChange={v => update("pvUnitCost", v)} step={10000} tooltip="Cost per kW in Uzbekistani Som" />
            <InputField label="O&M Cost" unit="% of Cpv/yr" value={params.comPercent} onChange={v => update("comPercent", v)} step={0.1} tooltip="Annual O&M cost as % of total system cost" />
            <InputField label="O&M Escalation" unit="%/yr" value={params.eom} onChange={v => update("eom", v)} step={0.1} tooltip="Annual escalation rate of O&M costs" />
            <InputField label="Annual PV Yield" unit="kWh/kW/yr" value={params.epv} onChange={v => update("epv", v)} step={10} tooltip="Annual electricity production per kW" />
            <InputField label="Degradation Factor" unit="%/yr" value={params.fEpv} onChange={v => update("fEpv", v)} step={0.1} tooltip="Annual panel efficiency degradation" />

            <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", margin: "18px 0 14px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Financial Parameters
            </div>
            <InputField label="Electricity Price" unit="UZS/kWh" value={params.pEpv} onChange={v => update("pEpv", v)} step={50} tooltip="Current retail electricity price in UZS" />
            <InputField label="Electricity Price Increase" unit="%/yr" value={params.ep} onChange={v => update("ep", v)} step={0.1} tooltip="Annual real increase in electricity price" />
            <InputField label="Discount Rate (WACC)" unit="%" value={params.d} onChange={v => update("d", v)} step={0.5} tooltip="Weighted average cost of capital" />
            <InputField label="System Lifetime" unit="years" value={params.n} onChange={v => update("n", v)} step={1} tooltip="Serviceable life of PV system" />
            <InputField label="Own Capital" unit="%" value={params.ownCapitalPercent} onChange={v => update("ownCapitalPercent", v)} step={5} tooltip="Percentage financed with own capital" />
            <InputField label="Loan Period" unit="years" value={params.loanYears} onChange={v => update("loanYears", v)} step={1} tooltip="Bank loan depreciation period" />
            <InputField label="Loan Interest Rate" unit="%/yr" value={params.loanRate} onChange={v => update("loanRate", v)} step={0.25} tooltip="Annual interest rate on bank loan" />
          </div>

          {/* Results Panel */}
          <div>
            {/* Key Metrics */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
              <ResultCard
                label="LCOE"
                uzsValue={results.lcoe.toFixed(1)}
                usdValue={(results.lcoe / rate).toFixed(4)}
                unit="UZS/kWh"
                color="#4ecdc4"
                subtitle={gridParity ? "✓ Grid parity reached" : "✗ Above grid price"}
              />
              <ResultCard
                label="NPV"
                uzsValue={fmtUzs(results.npv)}
                usdValue={fmtUsd(results.npv / rate)}
                color={results.npv >= 0 ? "#5b9cf6" : "#e85d75"}
                subtitle={results.npv >= 0 ? "Profitable" : "Loss"}
              />
              <ResultCard
                label="IRR"
                uzsValue={results.irr.toFixed(1)}
                unit="%"
                color="#f0a535"
                subtitle={results.irr > params.d ? `Above WACC (${params.d}%)` : "Below WACC"}
              />
              <ResultCard
                label="DPBT"
                uzsValue={results.dpbt.toFixed(1)}
                unit="yrs"
                color="#c084fc"
                subtitle={`of ${params.n} yr lifetime`}
              />
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
                  LCOE {results.lcoe.toFixed(1)} UZS/kWh vs Grid {params.pEpv.toFixed(1)} UZS/kWh
                  {" "}({gridParity ? "saving" : "costing"} {Math.abs((params.pEpv - results.lcoe) * 100 / params.pEpv).toFixed(1)}% {gridParity ? "less" : "more"})
                </div>
              </div>
            </div>

            {/* Investment Summary */}
            <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Investment Summary
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 12px", fontSize: 12 }}>
                <div style={{ color: "#5b7a9e", fontSize: 11, fontWeight: 600 }}>Item</div>
                <div style={{ color: "#5b7a9e", fontSize: 11, fontWeight: 600 }}>UZS</div>
                <div style={{ color: "#5b7a9e", fontSize: 11, fontWeight: 600 }}>USD</div>
                {[
                  ["Total System Cost", results.cpv, results.cpv / rate],
                  ["Own Capital", results.ownCapital, results.ownCapital / rate],
                  ["Loan Amount", results.loanPrincipal, results.loanPrincipal / rate],
                  ["Annual Loan Payment", results.annualLoanPayment, results.annualLoanPayment / rate],
                  ["Year-1 Revenue", params.pvPower * params.epv * params.pEpv, (params.pvPower * params.epv * params.pEpv) / rate],
                ].map(([k, uzs, usd], i) => (
                  <>
                    <div key={`k${i}`} style={{ color: "#6b7f9e", padding: "5px 0", borderBottom: "1px solid #1a2d45" }}>{k}</div>
                    <div key={`u${i}`} style={{ color: "#c8d9ed", fontFamily: "'JetBrains Mono', monospace", padding: "5px 0", borderBottom: "1px solid #1a2d45" }}>
                      {fmtUzs(uzs)} UZS
                    </div>
                    <div key={`d${i}`} style={{ color: "#8ab4d4", fontFamily: "'JetBrains Mono', monospace", padding: "5px 0", borderBottom: "1px solid #1a2d45" }}>
                      ${fmtUsd(usd)}
                    </div>
                  </>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: "#5b7a9e" }}>
                Year-1 Energy Output: {(params.pvPower * params.epv).toLocaleString()} kWh
              </div>
            </div>

            {/* Chart */}
            <div style={{ background: "#111e30", border: "1px solid #1e3050", borderRadius: 14, padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#5b9cf6", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Cumulative Discounted Cash Flow
              </div>
              <div style={{ fontSize: 11, color: "#5b7a9e", marginBottom: 8 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: "#4ecdc4", borderRadius: 2, marginRight: 4 }}></span>Positive
                <span style={{ display: "inline-block", width: 10, height: 10, background: "#e85d75", borderRadius: 2, marginLeft: 12, marginRight: 4 }}></span>Negative
              </div>
              <MiniBar data={results.yearlyData} />
            </div>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: "#3a5070" }}>
          Methodology: Squatrito, Sgroi, Tudisca, Di Trapani & Testa — Energies 2014, 7, 7147–7165
        </div>
      </div>
    </div>
  );
}
