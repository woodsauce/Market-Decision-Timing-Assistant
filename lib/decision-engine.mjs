export const CHECKPOINT_MINUTES = [12, 10, 8, 6, 4, 2];

export const PROFILES = {
  balanced: {
    label: 'Balanced',
    minConfidence: 64,
    minEdge: 4,
    minStability: 55,
    maxFlipRisk: 44,
    aggression: 1.0,
    preferredWindow: [360, 540],
    description: 'Default profile. Best blend of accuracy, timing, and skip discipline.'
  },
  sniper: {
    label: 'Sniper',
    minConfidence: 76,
    minEdge: 9,
    minStability: 70,
    maxFlipRisk: 28,
    aggression: 0.72,
    preferredWindow: [240, 420],
    description: 'Fewer trades. Only fires when the read is unusually clean.'
  },
  early: {
    label: 'Early Entry',
    minConfidence: 58,
    minEdge: 3,
    minStability: 62,
    maxFlipRisk: 40,
    aggression: 1.18,
    preferredWindow: [480, 720],
    description: 'Tries to solve the late-entry problem by allowing stable 8–12 minute entries.'
  },
  momentum: {
    label: 'Momentum Rider',
    minConfidence: 62,
    minEdge: 5,
    minStability: 50,
    maxFlipRisk: 48,
    aggression: 1.12,
    preferredWindow: [240, 600],
    description: 'Favors continuation when trend and acceleration agree.'
  },
  reversal: {
    label: 'Reversal Hunter',
    minConfidence: 67,
    minEdge: 6,
    minStability: 58,
    maxFlipRisk: 38,
    aggression: 0.92,
    preferredWindow: [180, 420],
    description: 'Looks for overextended moves that may snap back toward the target.'
  },
  aggressive: {
    label: 'Aggressive',
    minConfidence: 55,
    minEdge: 2,
    minStability: 42,
    maxFlipRisk: 58,
    aggression: 1.32,
    preferredWindow: [120, 720],
    description: 'More trades. Higher risk of losses and flips.'
  },
  guardian: {
    label: 'No-Trade Guardian',
    minConfidence: 82,
    minEdge: 12,
    minStability: 75,
    maxFlipRisk: 24,
    aggression: 0.55,
    preferredWindow: [240, 420],
    description: 'Protective layer. Blocks low-quality setups.'
  }
};

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function round(value, places = 2) {
  const p = 10 ** places;
  return Math.round((Number(value) || 0) * p) / p;
}

export function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i += 1) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

export function sma(values, period = values.length) {
  const slice = values.slice(-period);
  if (!slice.length) return null;
  return slice.reduce((sum, item) => sum + item, 0) / slice.length;
}

export function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = sma(values);
  const variance = values.reduce((sum, item) => sum + (item - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow) return { macdLine: 0, signalLine: 0, histogram: 0 };
  const diffs = [];
  for (let i = slow; i <= values.length; i += 1) {
    const window = values.slice(0, i);
    diffs.push((ema(window, fast) || 0) - (ema(window, slow) || 0));
  }
  const macdLine = diffs.at(-1) || 0;
  const signalLine = ema(diffs, Math.min(signal, diffs.length)) || 0;
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

export function buildCandles(ticks, intervalMs = 60000) {
  const sorted = [...ticks]
    .filter((tick) => Number.isFinite(tick.price) && Number.isFinite(tick.ts))
    .sort((a, b) => a.ts - b.ts);
  const buckets = new Map();
  for (const tick of sorted) {
    const bucket = Math.floor(tick.ts / intervalMs) * intervalMs;
    const candle = buckets.get(bucket) || {
      ts: bucket,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: 0,
      ticks: 0
    };
    candle.high = Math.max(candle.high, tick.price);
    candle.low = Math.min(candle.low, tick.price);
    candle.close = tick.price;
    candle.volume += Number(tick.volume || 0);
    candle.ticks += 1;
    buckets.set(bucket, candle);
  }
  return [...buckets.values()];
}

export function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  const slice = candles.slice(-(period + 1));
  for (let i = 1; i < slice.length; i += 1) {
    const current = slice[i];
    const previous = slice[i - 1];
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return sma(trs) || 0;
}

export function slopePerMinute(ticks, lookbackMs = 180000) {
  const latest = ticks.at(-1);
  if (!latest) return 0;
  const since = latest.ts - lookbackMs;
  const sample = ticks.filter((tick) => tick.ts >= since);
  if (sample.length < 2) return 0;
  const first = sample[0];
  const last = sample.at(-1);
  const minutes = Math.max((last.ts - first.ts) / 60000, 0.01);
  return (last.price - first.price) / minutes;
}

export function nearestCheckpoint(remainingSec) {
  const remainingMin = remainingSec / 60;
  let nearest = CHECKPOINT_MINUTES[0];
  let distance = Infinity;
  for (const cp of CHECKPOINT_MINUTES) {
    const d = Math.abs(remainingMin - cp);
    if (d < distance) {
      nearest = cp;
      distance = d;
    }
  }
  return nearest;
}

export function shouldCaptureCheckpoint(previousRemainingSec, currentRemainingSec, captured = {}) {
  if (!Number.isFinite(currentRemainingSec) || !Number.isFinite(previousRemainingSec)) return null;
  for (const minutes of CHECKPOINT_MINUTES) {
    const threshold = minutes * 60;
    const wasAbove = previousRemainingSec > threshold;
    const nowAtOrBelow = currentRemainingSec <= threshold;
    if (wasAbove && nowAtOrBelow && !captured[String(minutes)]) return minutes;
  }
  return null;
}

export function calculateStability(recentDecisions = []) {
  const usable = recentDecisions.filter((item) => item && item.choice && item.choice !== 'SKIP').slice(-5);
  if (usable.length < 2) return 50;
  const lastChoice = usable.at(-1).choice;
  const same = usable.filter((item) => item.choice === lastChoice).length;
  const confs = usable.map((item) => Number(item.confidence) || 0);
  const confStd = standardDeviation(confs);
  const base = (same / usable.length) * 100;
  return clamp(base - confStd * 0.42, 0, 100);
}

export function scoreMarketPrice(choice, market = {}) {
  const yes = Number(market.yesPrice ?? market.yes_bid ?? market.yes_ask ?? market.last_price ?? 0);
  const no = Number(market.noPrice ?? market.no_bid ?? market.no_ask ?? 0);
  const price = choice === 'OVER' ? yes : no;
  if (!price) return { price: null, valueScore: 50, isFair: true };
  const cents = price > 1 ? price : price * 100;
  const valueScore = clamp(100 - Math.max(cents - 64, 0) * 2.5 - Math.max(18 - cents, 0) * 1.4, 0, 100);
  return { price: round(cents, 1), valueScore, isFair: cents <= 84 };
}

function determineBaseChoice({ price, targetPrice, trendScore, momentumScore, reversalBias }) {
  const gap = price - targetPrice;
  const directionScore = gap * 0.14 + trendScore * 0.52 + momentumScore * 0.32 - reversalBias * 0.18;
  if (directionScore > 0.55) return 'OVER';
  if (directionScore < -0.55) return 'UNDER';
  return gap >= 0 ? 'OVER' : 'UNDER';
}

export function evaluateDecision(input = {}) {
  const ticks = [...(input.ticks || [])]
    .filter((tick) => Number.isFinite(tick.price) && Number.isFinite(tick.ts))
    .sort((a, b) => a.ts - b.ts);
  const profile = PROFILES[input.profile] || PROFILES.balanced;
  const latest = ticks.at(-1);
  const price = Number(input.currentPrice ?? latest?.price ?? 0);
  const targetPrice = Number(input.targetPrice ?? 0);
  const remainingSec = Number(input.timeRemainingSec ?? 0);
  const recentDecisions = input.recentDecisions || [];

  if (!price || !targetPrice) {
    return emptyDecision('WAIT', 'Need live BTC price and target price.', profile, remainingSec);
  }

  const prices = ticks.map((tick) => tick.price);
  const candles = buildCandles(ticks, 60000);
  const ema9 = ema(prices, Math.min(9, prices.length)) || price;
  const ema21 = ema(prices, Math.min(21, prices.length)) || price;
  const ema50 = ema(prices, Math.min(50, prices.length)) || price;
  const currentRsi = rsi(prices, Math.min(14, Math.max(3, prices.length - 1)));
  const currentMacd = macd(prices, 12, 26, 9);
  const currentAtr = atr(candles, Math.min(14, Math.max(2, candles.length - 1)));
  const recentSlope = slopePerMinute(ticks, 180000);
  const shortSlope = slopePerMinute(ticks, 60000);
  const sd = standardDeviation(prices.slice(-30));
  const gap = price - targetPrice;
  const moveNeededPerMinute = remainingSec > 0 ? Math.abs(gap) / Math.max(remainingSec / 60, 0.1) : Math.abs(gap);
  const trendScore = ((ema9 - ema21) * 0.9 + (ema21 - ema50) * 0.5 + recentSlope * 0.75) / Math.max(currentAtr || sd || 8, 4);
  const momentumScore = ((currentRsi - 50) / 12) + (currentMacd.histogram / Math.max(currentAtr || sd || 8, 4)) + shortSlope / Math.max(currentAtr || sd || 8, 4);
  const overextended = Math.abs(gap) > Math.max(currentAtr * 1.6, sd * 1.2, 25);
  const reversalBias = overextended ? Math.sign(gap) * clamp(Math.abs(currentRsi - 50) / 20, 0, 2) : 0;

  let choice = determineBaseChoice({ price, targetPrice, trendScore, momentumScore, reversalBias });

  if (input.profile === 'reversal' && overextended && Math.abs(currentRsi - 50) > 18) {
    choice = gap > 0 ? 'UNDER' : 'OVER';
  }

  const directionalEdge = choice === 'OVER'
    ? gap * 0.07 + trendScore * 7 + momentumScore * 6
    : -gap * 0.07 - trendScore * 7 - momentumScore * 6;
  const distanceScore = clamp(Math.abs(gap) / Math.max(moveNeededPerMinute + 1, 1) * 3.2, 0, 32);
  const indicatorAgreement = [
    choice === 'OVER' ? ema9 >= ema21 : ema9 <= ema21,
    choice === 'OVER' ? ema21 >= ema50 : ema21 <= ema50,
    choice === 'OVER' ? recentSlope >= 0 : recentSlope <= 0,
    choice === 'OVER' ? currentRsi >= 50 : currentRsi <= 50,
    choice === 'OVER' ? currentMacd.histogram >= 0 : currentMacd.histogram <= 0,
    choice === 'OVER' ? gap >= 0 : gap <= 0
  ].filter(Boolean).length;
  const agreementScore = indicatorAgreement / 6 * 36;
  const timeSweetSpot = scoreTimeWindow(remainingSec, profile.preferredWindow);
  const stability = calculateStability([...recentDecisions, { choice, confidence: 50 + agreementScore }]);
  const marketValue = scoreMarketPrice(choice, input.market || {});
  const noisePenalty = clamp((sd / Math.max(Math.abs(gap), 8)) * 12, 0, 24);
  const flipRisk = clamp(100 - stability * 0.42 - agreementScore * 0.65 + noisePenalty + (overextended ? 8 : 0), 0, 100);

  const confidence = clamp(
    34 + agreementScore + distanceScore + clamp(directionalEdge, -20, 22) * profile.aggression + timeSweetSpot * 0.18 + marketValue.valueScore * 0.08 - flipRisk * 0.16,
    1,
    99
  );

  const edge = Math.abs(directionalEdge) + distanceScore * 0.35;
  const priceTooClose = Math.abs(gap) < Math.max(currentAtr * 0.28, sd * 0.25, 5) && remainingSec < 360;
  const lateDanger = remainingSec <= 120 && confidence < 82;
  const notEnoughData = ticks.length < 8;
  const shouldSkip =
    notEnoughData ||
    confidence < profile.minConfidence ||
    edge < profile.minEdge ||
    stability < profile.minStability ||
    flipRisk > profile.maxFlipRisk ||
    priceTooClose ||
    lateDanger ||
    !marketValue.isFair;

  const checkpoint = nearestCheckpoint(remainingSec);
  const action = shouldSkip ? 'SKIP' : choice;
  const readiness = readinessText({ action, remainingSec, confidence, stability, flipRisk, profile, marketValue });

  return {
    action,
    choice,
    checkpoint,
    profile: profile.label,
    profileKey: input.profile || 'balanced',
    confidence: round(confidence, 1),
    edge: round(edge, 1),
    stability: round(stability, 1),
    flipRisk: round(flipRisk, 1),
    readiness,
    currentPrice: round(price, 2),
    targetPrice: round(targetPrice, 2),
    gap: round(gap, 2),
    moveNeededPerMinute: round(moveNeededPerMinute, 2),
    indicators: {
      ema9: round(ema9, 2),
      ema21: round(ema21, 2),
      ema50: round(ema50, 2),
      rsi: round(currentRsi, 1),
      macdHistogram: round(currentMacd.histogram, 4),
      atr: round(currentAtr, 2),
      slope3m: round(recentSlope, 2),
      volatility: round(sd, 2),
      agreement: indicatorAgreement
    },
    marketValue,
    flags: {
      notEnoughData,
      priceTooClose,
      lateDanger,
      overextended,
      marketPriceTooHigh: !marketValue.isFair
    },
    reasons: buildReasons({ choice, action, gap, trendScore, momentumScore, confidence, stability, flipRisk, marketValue, timeSweetSpot, indicatorAgreement })
  };
}

function scoreTimeWindow(remainingSec, [min, max]) {
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return 15;
  if (remainingSec >= min && remainingSec <= max) return 100;
  const distance = remainingSec < min ? min - remainingSec : remainingSec - max;
  return clamp(100 - distance / 3.8, 10, 100);
}

function readinessText({ action, remainingSec, confidence, stability, flipRisk, profile, marketValue }) {
  if (action === 'SKIP') {
    if (!marketValue.isFair) return 'Skip: contract price is too expensive for this assistant.';
    if (flipRisk > profile.maxFlipRisk) return 'Skip: flip risk is too high.';
    if (stability < profile.minStability) return 'Wait/skip: signal has not stayed stable long enough.';
    if (confidence < profile.minConfidence) return 'Wait/skip: confidence is below this profile threshold.';
    return 'Skip: setup quality is not good enough.';
  }
  if (remainingSec >= 480) return 'Early entry allowed only if the same side holds for 60–90 seconds.';
  if (remainingSec >= 300) return 'Primary lock zone. This is the preferred entry window.';
  if (remainingSec >= 120) return 'Late confirmation zone. Enter only if price and confidence are still favorable.';
  return 'No-chase zone. Enter only if already planned and the price is fair.';
}

function buildReasons({ choice, action, gap, trendScore, momentumScore, confidence, stability, flipRisk, marketValue, timeSweetSpot, indicatorAgreement }) {
  const reasons = [];
  reasons.push(`${choice} favored: BTC is ${gap >= 0 ? 'above' : 'below'} target by $${Math.abs(gap).toFixed(2)}.`);
  reasons.push(`Indicator agreement: ${indicatorAgreement}/6.`);
  reasons.push(`Trend score ${round(trendScore, 2)}, momentum score ${round(momentumScore, 2)}.`);
  reasons.push(`Confidence ${round(confidence, 1)}%, stability ${round(stability, 1)}%, flip risk ${round(flipRisk, 1)}%.`);
  reasons.push(`Timing score ${round(timeSweetSpot, 1)}. Market value score ${round(marketValue.valueScore, 1)}.`);
  if (action === 'SKIP') reasons.push('Final action is SKIP because at least one protection threshold failed.');
  return reasons;
}

function emptyDecision(action, reason, profile, remainingSec) {
  return {
    action,
    choice: 'WAIT',
    checkpoint: nearestCheckpoint(Number(remainingSec || 0)),
    profile: profile.label,
    confidence: 0,
    edge: 0,
    stability: 0,
    flipRisk: 100,
    readiness: reason,
    currentPrice: 0,
    targetPrice: 0,
    gap: 0,
    moveNeededPerMinute: 0,
    indicators: {},
    marketValue: { price: null, valueScore: 50, isFair: true },
    flags: { notEnoughData: true },
    reasons: [reason]
  };
}

export function createRecord({ decision, market = {}, userEntry = null, ts = Date.now() }) {
  return {
    id: `${ts}-${Math.random().toString(16).slice(2)}`,
    ts,
    ticker: market.ticker || market.market_ticker || '',
    title: market.title || market.subtitle || '',
    targetPrice: decision.targetPrice,
    currentPrice: decision.currentPrice,
    checkpoint: decision.checkpoint,
    profileKey: decision.profileKey,
    profile: decision.profile,
    recommendation: decision.action,
    choice: decision.choice,
    confidence: decision.confidence,
    stability: decision.stability,
    flipRisk: decision.flipRisk,
    userEntry: userEntry || decision.action,
    result: decision.action === 'SKIP' ? 'skipped' : 'open',
    finalPrice: null,
    reasons: decision.reasons,
    checkpoints: {}
  };
}

export function settleRecord(record, result, finalPrice = null) {
  const normalized = ['win', 'loss', 'skipped', 'void'].includes(result) ? result : 'void';
  return {
    ...record,
    result: normalized,
    finalPrice: Number.isFinite(Number(finalPrice)) ? Number(finalPrice) : record.finalPrice,
    settledAt: Date.now()
  };
}

export function summarizeRecords(records = []) {
  const summary = {
    total: records.length,
    wins: 0,
    losses: 0,
    skipped: 0,
    open: 0,
    void: 0,
    winRate: 0,
    byProfile: {},
    byCheckpoint: {}
  };
  for (const record of records) {
    const result = record.result || 'open';
    if (result === 'win') summary.wins += 1;
    else if (result === 'loss') summary.losses += 1;
    else if (result === 'skipped') summary.skipped += 1;
    else if (result === 'void') summary.void += 1;
    else summary.open += 1;

    const p = record.profile || 'Unknown';
    const c = String(record.checkpoint || '?');
    summary.byProfile[p] ||= { wins: 0, losses: 0, skipped: 0, open: 0, winRate: 0 };
    summary.byCheckpoint[c] ||= { wins: 0, losses: 0, skipped: 0, open: 0, winRate: 0 };
    for (const bucket of [summary.byProfile[p], summary.byCheckpoint[c]]) {
      if (result === 'win') bucket.wins += 1;
      else if (result === 'loss') bucket.losses += 1;
      else if (result === 'skipped') bucket.skipped += 1;
      else bucket.open += 1;
    }
  }
  const decided = summary.wins + summary.losses;
  summary.winRate = decided ? round(summary.wins / decided * 100, 1) : 0;
  for (const bucket of [...Object.values(summary.byProfile), ...Object.values(summary.byCheckpoint)]) {
    const decidedBucket = bucket.wins + bucket.losses;
    bucket.winRate = decidedBucket ? round(bucket.wins / decidedBucket * 100, 1) : 0;
  }
  return summary;
}
