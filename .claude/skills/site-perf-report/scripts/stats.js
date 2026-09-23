// Summary statistics over PSI samples, shared by audit.js and merge.js.
//
// A "sample" is one PSI run of one URL on one form factor:
//   {id, burst, at, score, metrics:{fcp,lcp,tbt,cls,si,tti}, bi, lhv, opportunities?}
//
// Why median + typical range, not mean or mode: PSI scores on the same page
// spread 20-30 points within minutes (Google's machines differ in CPU speed,
// which moves TBT). The mean is dragged by the outliers; the mode of 0-100
// integer scores is decided by chance (two identical 10-run batches of
// trafft.com had desktop modes 89 and 78). The median is robust, and the
// typical range — the narrowest interval holding 60% of the samples — shows
// where the page actually sits without letting one bad run set the range.

const TYPICAL_SHARE = 0.6;

function median(values) {
  const s = values.filter(v => typeof v === "number" && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function typicalRange(scores, share = TYPICAL_SHARE) {
  const s = scores.filter(v => typeof v === "number").sort((a, b) => a - b);
  if (s.length < 3) return null;
  const k = Math.max(2, Math.ceil(s.length * share));
  let best = null;
  for (let i = 0; i + k <= s.length; i++) {
    const w = s[i + k - 1] - s[i];
    if (!best || w < best.hi - best.lo) best = { lo: s[i], hi: s[i + k - 1] };
  }
  return Object.assign(best, { share, of: s.length });
}

const round = {
  cls: v => Math.round(v * 10000) / 10000,
  tbt: v => Math.round(v),
  default: v => Math.round(v * 10) / 10
};

// Pool samples (deduplicated by id) into the block the dashboard reads.
function summarise(samples, { keepSampleDetail = true } = {}) {
  const seen = new Set();
  const all = samples.filter(s => s && typeof s.score === "number" && (!s.id || !seen.has(s.id)) && (s.id ? seen.add(s.id) : true));
  if (!all.length) return null;

  const scores = all.map(s => s.score).sort((a, b) => a - b);
  const score = Math.round(median(scores));

  const metrics = {};
  const keys = new Set(all.flatMap(s => Object.keys(s.metrics || {})));
  for (const k of keys) {
    const v = median(all.map(s => s.metrics && s.metrics[k]));
    if (v !== null) metrics[k] = (round[k] || round.default)(v);
  }

  // Opportunities come from one real run — the one closest to the median
  // score — rather than being averaged into savings no run actually had.
  const withOpps = all.filter(s => Array.isArray(s.opportunities));
  const rep = (withOpps.length ? withOpps : all)
    .slice().sort((a, b) => Math.abs(a.score - score) - Math.abs(b.score - score))[0];

  const bursts = new Set(all.map(s => s.burst).filter(b => b !== undefined && b !== null));
  const lhv = all.map(s => s.lhv).filter(Boolean);

  return {
    score,
    metrics,
    opportunities: rep.opportunities || [],
    benchmarkIndex: median(all.map(s => s.bi)) === null ? null : Math.round(median(all.map(s => s.bi))),
    lighthouseVersion: lhv.length ? lhv[lhv.length - 1] : null,
    runs: all.length,
    bursts: bursts.size || 1,
    spread: scores.length > 1 ? { min: scores[0], max: scores[scores.length - 1] } : null,
    typical: typicalRange(scores),
    allScores: scores,
    samples: all.map(s => {
      // The final document (keepSampleDetail false) keeps what history
      // analysis needs; ids, versions and opportunities stay in the
      // intermediate audit.js outputs.
      const c = { burst: s.burst, at: s.at, score: s.score, metrics: s.metrics, bi: s.bi };
      if (keepSampleDetail) { c.id = s.id; c.lhv = s.lhv; if (s.opportunities) c.opportunities = s.opportunities; }
      return c;
    })
  };
}

module.exports = { median, typicalRange, summarise, TYPICAL_SHARE };
