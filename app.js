import {
  CHECKPOINT_MINUTES,
  PROFILES,
  evaluateDecision,
  createRecord,
  settleRecord,
  summarizeRecords,
  shouldCaptureCheckpoint
} from './lib/decision-engine.mjs';

const APP_VERSION_FILE = 'edge15-live-return-11.zip';
const LEARNING_SAMPLE_TARGET = 25;
const STORE_KEY = 'edge15.records.v1';
const SETTINGS_KEY = 'edge15.settings.v1';
const LADDERS_KEY = 'edge15.ladders.v1';
const CURRENT_LADDER_KEY = 'edge15.currentLadder.v1';
const MAX_TICKS = 900;
const BASE_HOLD_MS = 75_000;
const ENTRY_HOLD_MS = 120_000;
const STRONG_HOLD_MS = 150_000;
const SWITCH_CONFIRM_MS = 22_000;
const COMPLETED_LADDER_LIMIT = 10;
const ENTRY_MINUTES = Array.from({ length: 15 }, (_, index) => 15 - index);
const PRIORITY_PROFILES = ['balanced', 'aggressive', 'no_chase'];
const TRACKER_LOCK_VERSION = 11;
const ASSUMED_STAKE_DOLLARS = 0.50;

const state = {
  ticks: [],
  records: loadRecords(),
  ladders: loadLadders(),
  currentLadder: loadCurrentLadder(),
  settings: loadSettings(),
  decision: null,
  rawDecision: null,
  previousRemainingSec: null,
  capturedCheckpoints: {},
  capturedEntryMinutes: loadCurrentLadder()?.entryMinutes || {},
  checkpointHistory: [],
  market: null,
  orderbook: null,
  coinbasePrediction: null,
  localPrediction: null,
  signalHistory: [],
  predictionPriceHistory: [],
  heldDecision: null,
  pendingSwitch: null,
  ws: null,
  lastWsMessageAt: 0,
  refreshTimer: null,
  predictionTimer: null,
  countdownTimer: null,
  manualEndAt: loadSettings().manualEndAt || null
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—';
const fmtPct = (value) => `${Number(value || 0).toFixed(1)}%`;

init();

function init() {
  hydrateSettings();
  renderProfiles();
  renderLadder();
  renderCompletedLadders();
  renderRecords();
  renderStats();
  renderLadderStats();
  renderLearningEngine();
  renderTimingEngine();
  renderEntryMinuteTracker();
  renderLiveReturnTracker();
  wireEvents();
  loadCoinbaseCandles();
  connectCoinbase();
  loadCoinbasePrediction(true);
  checkApiHealth();
  startLoops();
  evaluateAndRender();
}

function hydrateSettings() {
  $('targetPrice').value = state.settings.targetPrice || '';
  $('minutesLeft').value = state.settings.minutesLeft || '5.5';
  $('refreshSeconds').value = state.settings.refreshSeconds || '3';
  const ticker = $('marketTicker');
  if (ticker) ticker.value = state.settings.marketTicker || '';
  const version = $('versionName');
  if (version) version.textContent = APP_VERSION_FILE;
}


function renderProfiles() {
  const select = $('profileSelect');
  const entries = [
    ...PRIORITY_PROFILES.map((key) => [key, PROFILES[key]]).filter(([, profile]) => profile),
    ...Object.entries(PROFILES).filter(([key]) => !PRIORITY_PROFILES.includes(key))
  ];
  select.innerHTML = entries.map(([key, profile]) =>
    `<option value="${key}">${profile.label}</option>`
  ).join('');
  select.value = PROFILES[state.settings.profile] ? state.settings.profile : 'balanced';
}

function wireEvents() {
  ['targetPrice', 'profileSelect', 'refreshSeconds', 'marketTicker'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      saveSettingsFromUi();
      if (id === 'refreshSeconds') restartRefreshLoop();
      if (id === 'targetPrice') resetDecisionSession(false);
      evaluateAndRender();
    });
  });
  $('minutesLeft').addEventListener('input', () => {
    const minutes = Number($('minutesLeft').value);
    state.manualEndAt = Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60000 : null;
    resetDecisionSession(false);
    saveSettingsFromUi();
    evaluateAndRender();
  });
  $('useCurrentAsTarget').addEventListener('click', setTargetFromCurrent);
  $('start15m').addEventListener('click', () => startManualCountdown(15));
  $('resetSession').addEventListener('click', () => resetDecisionSession(true));
  $('recordDecision').addEventListener('click', () => recordCurrentDecision());
  $('skipTrade').addEventListener('click', () => recordCurrentDecision('skip'));
  const refreshPrediction = $('refreshPrediction');
  if (refreshPrediction) refreshPrediction.addEventListener('click', () => loadCoinbasePrediction(false));
  const copyBtn = $('copyVersionName');
  if (copyBtn) copyBtn.addEventListener('click', copyVersionName);
  $('exportTracker').addEventListener('click', exportTracker);
  $('clearTracker').addEventListener('click', clearTracker);
}

function startLoops() {
  restartRefreshLoop();
  state.predictionTimer = setInterval(() => loadCoinbasePrediction(true), 15000);
  state.countdownTimer = setInterval(() => {
    updateTimeLeft();
    evaluateAndRender(false);
  }, 1000);
}

function restartRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const seconds = Math.max(1, Number($('refreshSeconds').value || 3));
  state.refreshTimer = setInterval(() => evaluateAndRender(), seconds * 1000);
}

async function loadCoinbaseCandles() {
  try {
    const response = await fetch('/api/coinbase/candles?granularity=60&minutes=90', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok || !Array.isArray(data.candles)) throw new Error(data.error || 'Candle preload failed');

    const preloadTicks = data.candles.flatMap((candle) => ([
      { price: Number(candle.open), ts: Number(candle.ts), volume: Number(candle.volume || 0) / 3, source: 'coinbase-candle-open' },
      { price: Number(candle.high), ts: Number(candle.ts) + 20_000, volume: Number(candle.volume || 0) / 3, source: 'coinbase-candle-high' },
      { price: Number(candle.close), ts: Number(candle.ts) + 59_000, volume: Number(candle.volume || 0) / 3, source: 'coinbase-candle-close' }
    ])).filter((tick) => Number.isFinite(tick.price) && Number.isFinite(tick.ts));

    state.ticks = [...state.ticks, ...preloadTicks]
      .sort((a, b) => a.ts - b.ts)
      .filter((tick, index, arr) => index === 0 || tick.ts !== arr[index - 1].ts || tick.price !== arr[index - 1].price)
      .slice(-MAX_TICKS);

    updateLocalPredictionFromTicks();
    drawSparkline();
    evaluateAndRender(false);
    const debug = $('apiDebug');
    if (debug) debug.textContent = `Loaded ${data.candles.length} Coinbase 1-minute candles for startup context.`;
  } catch (error) {
    const debug = $('apiDebug');
    if (debug) debug.textContent = `Coinbase candle preload failed: ${error.message}. Live WebSocket ticks will still work.`;
  }
}

function connectCoinbase() {
  try {
    if (state.ws) state.ws.close();
    const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
    state.ws = ws;
    $('coinbaseStatus').textContent = 'Coinbase: connecting';
    $('coinbaseStatus').className = 'pill warn';

    ws.addEventListener('open', () => {
      $('coinbaseStatus').textContent = 'Coinbase: live';
      $('coinbaseStatus').className = 'pill good';
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }));
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'market_trades' }));
    });

    ws.addEventListener('message', (event) => {
      const data = safeJson(event.data);
      const tick = parseCoinbaseTick(data);
      if (tick) {
        addTick(tick);
        state.lastWsMessageAt = Date.now();
        $('coinbaseStatus').textContent = 'Coinbase: live';
        $('coinbaseStatus').className = 'pill good';
        renderMarketBasics();
        drawSparkline();
        evaluateAndRender(false);
      }
    });

    ws.addEventListener('close', () => {
      $('coinbaseStatus').textContent = 'Coinbase: reconnecting';
      $('coinbaseStatus').className = 'pill warn';
      setTimeout(connectCoinbase, 1800);
    });

    ws.addEventListener('error', () => {
      $('coinbaseStatus').textContent = 'Coinbase: error';
      $('coinbaseStatus').className = 'pill bad';
    });
  } catch (error) {
    $('coinbaseStatus').textContent = 'Coinbase: failed';
    $('coinbaseStatus').className = 'pill bad';
  }
}

function parseCoinbaseTick(data) {
  if (!data || data.type === 'subscriptions') return null;
  const candidates = [];
  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      if (Array.isArray(event.tickers)) candidates.push(...event.tickers);
      if (Array.isArray(event.trades)) candidates.push(...event.trades);
      if (Array.isArray(event.candles)) candidates.push(...event.candles);
    }
  }
  candidates.push(data);
  for (const item of candidates) {
    const rawPrice = item.price || item.last_price || item.best_bid || item.best_ask || item.close;
    const price = Number(rawPrice);
    if (Number.isFinite(price) && price > 0) {
      const rawTs = item.time || item.timestamp || data.timestamp || data.time;
      const ts = rawTs ? Date.parse(rawTs) || Date.now() : Date.now();
      const bestBid = Number(item.best_bid ?? item.bid ?? data.best_bid);
      const bestAsk = Number(item.best_ask ?? item.ask ?? data.best_ask);
      const side = String(item.side || item.taker_side || '').toUpperCase();
      return {
        price,
        ts,
        volume: Number(item.volume || item.size || 0),
        source: 'coinbase',
        bestBid: Number.isFinite(bestBid) ? bestBid : null,
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
        spread: Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? Math.max(0, bestAsk - bestBid) : null,
        side: side || null
      };
    }
  }
  return null;
}

function addTick(tick) {
  state.ticks.push(tick);
  if (state.ticks.length > MAX_TICKS) state.ticks = state.ticks.slice(-MAX_TICKS);
  updateLocalPredictionFromTicks();
}

function updateLocalPredictionFromTicks(now = Date.now()) {
  const latest = state.ticks.at(-1);
  if (!latest) return null;
  const windowMs = 15 * 60 * 1000;
  const startAt = Math.floor(now / windowMs) * windowMs;
  const closeAt = startAt + windowMs;

  const currentKey = new Date(closeAt).toISOString();
  const existing = state.localPrediction;
  if (!existing || existing.windowKey !== currentKey) {
    const startTick = state.ticks.find((tick) => tick.ts >= startAt) || latest;
    state.localPrediction = {
      ok: true,
      source: 'local_coinbase_15m_window',
      title: `BTC 15 min · $${Number(startTick.price).toLocaleString(undefined, { maximumFractionDigits: 2 })} target`,
      ticker: `LOCAL-BTC15M-${currentKey}`,
      targetPrice: Number(startTick.price),
      yesPrice: null,
      noPrice: null,
      closeTime: new Date(closeAt).toISOString(),
      closeTimeSource: 'local_15m_boundary',
      fetchedAt: new Date(now).toISOString(),
      windowKey: currentKey
    };
    if (!hasFreshCoinbasePrediction(now)) {
      applyPredictionToUi(state.localPrediction, { reset: true, save: true, sourceLabel: 'local auto' });
    }
    return state.localPrediction;
  }

  if (!hasFreshCoinbasePrediction(now)) {
    applyPredictionToUi(existing, { reset: false, save: false, sourceLabel: 'local auto' });
  }
  return existing;
}

function hasFreshCoinbasePrediction(now = Date.now()) {
  const prediction = state.coinbasePrediction;
  if (!prediction?.targetPrice || !prediction?.closeTime) return false;
  const close = Date.parse(prediction.closeTime);
  const fetched = Date.parse(prediction.fetchedAt || 0);
  return Number.isFinite(close) && close > now && close - now <= 16 * 60 * 1000 && (!Number.isFinite(fetched) || now - fetched < 90_000);
}

function applyPredictionToUi(data, options = {}) {
  if (!data || !Number.isFinite(Number(data.targetPrice))) return;
  updatePredictionPriceHistory(data);
  const previousKey = [state.market?.ticker, $('targetPrice').value, state.market?.close_time].join('|');
  const nextKey = [data.ticker, data.targetPrice, data.closeTime].join('|');

  state.market = {
    source: data.source || 'coinbase_predictions',
    ticker: data.ticker || 'COINBASE-BTC-15M',
    title: data.title,
    close_time: data.closeTime,
    yes_bid: data.yesPrice,
    no_bid: data.noPrice,
    yesChange: getPredictionPriceContext().yesChange,
    noChange: getPredictionPriceContext().noChange,
    indicativeOnly: data.source === 'coinbase_predictions' || data.source === 'local_coinbase_15m_window'
  };

  state.orderbook = {
    yesPrice: data.yesPrice,
    noPrice: data.noPrice,
    yesChange: getPredictionPriceContext().yesChange,
    noChange: getPredictionPriceContext().noChange,
    source: data.source || 'coinbase_predictions',
    indicativeOnly: data.source === 'coinbase_predictions' || data.source === 'local_coinbase_15m_window',
    raw: data
  };

  $('targetPrice').value = String(data.targetPrice);
  const marketTickerEl = $('marketTicker');
  if (data.ticker && marketTickerEl) marketTickerEl.value = data.ticker;
  const remainingMinutes = Math.max(0, (Date.parse(data.closeTime) - Date.now()) / 60000);
  if (Number.isFinite(remainingMinutes)) $('minutesLeft').value = remainingMinutes.toFixed(2);

  if ((options.reset || previousKey !== nextKey) && previousKey !== nextKey) {
    finalizeCurrentLadder('new_window');
    resetDecisionSession(false);
  }
  ensureCurrentLadder();
  if (options.save) saveSettingsFromUi();
  renderMarketBasics();
}

function getRemainingSec() {
  const now = Date.now();
  const preferred = hasFreshCoinbasePrediction(now) ? state.coinbasePrediction : state.localPrediction;
  if (preferred?.closeTime) {
    const parsed = Date.parse(preferred.closeTime);
    if (Number.isFinite(parsed)) {
      const derived = Math.max(0, (parsed - now) / 1000);
      if (derived <= 15 * 60 + 45) return derived;
    }
  }
  if (state.market) {
    const closeTime = parseMarketCloseTime(state.market);
    if (closeTime) {
      const derived = Math.max(0, (closeTime - Date.now()) / 1000);
      if (derived <= 15 * 60 + 45) return derived;
    }
  }
  if (state.manualEndAt && state.manualEndAt > Date.now()) {
    return Math.max(0, (state.manualEndAt - Date.now()) / 1000);
  }
  const manualMinutes = Number($('minutesLeft').value);
  return Number.isFinite(manualMinutes) ? manualMinutes * 60 : 0;
}

function parseMarketCloseTime(market) {
  const fields = ['close_time', 'closeTime', 'expiration_time', 'expected_expiration_time', 'latest_expiration_time'];
  for (const field of fields) {
    if (!market?.[field]) continue;
    const parsed = Date.parse(market[field]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function updateTimeLeft() {
  updateLocalPredictionFromTicks();
  const remaining = getRemainingSec();
  $('timeLeftDisplay').textContent = formatRemaining(remaining);
}

function evaluateAndRender(capture = true) {
  updateLocalPredictionFromTicks();
  const remainingSec = getRemainingSec();
  const targetPrice = Number($('targetPrice').value);
  const profile = $('profileSelect').value;
  const marketContext = { ...(state.market || {}), ...(state.orderbook || {}), ...getMicrostructureContext(), ...getPredictionPriceContext() };
  const rawDecision = evaluateDecision({
    ticks: state.ticks,
    targetPrice,
    timeRemainingSec: remainingSec,
    profile,
    market: marketContext,
    recentDecisions: [...state.signalHistory, ...state.checkpointHistory]
  });
  state.rawDecision = rawDecision;
  rememberSignal(rawDecision);
  const decision = stabilizeDecision(rawDecision);
  state.decision = decision;

  ensureCurrentLadder();
  updateCurrentLadderDecision(decision);
  maybeLockOfficialCall(decision, remainingSec);
  captureEntryMinuteSnapshot(decision, remainingSec);

  if (capture) {
    const cp = shouldCaptureCheckpoint(state.previousRemainingSec, remainingSec, state.capturedCheckpoints);
    if (cp) {
      const checkpointDecision = { ...decision, checkpoint: cp, capturedAt: Date.now() };
      state.capturedCheckpoints[String(cp)] = checkpointDecision;
      state.checkpointHistory.push(checkpointDecision);
      updateCurrentLadderCheckpoint(cp, checkpointDecision);
    }
    state.previousRemainingSec = remainingSec;
  }

  if (remainingSec <= 1) finalizeCurrentLadder('window_closed');

  renderDecision(decision);
  renderLadder();
  renderMarketBasics();
  renderReasons(decision);
  renderIndicators(decision.indicators || {});
  drawSparkline();
}

function rememberSignal(decision) {
  if (!decision?.choice || decision.choice === 'WAIT') return;
  const now = Date.now();
  const last = state.signalHistory.at(-1);
  if (last && now - last.ts < 1200 && last.choice === decision.choice && last.action === decision.action) return;
  state.signalHistory.push({
    choice: decision.choice,
    action: decision.action,
    confidence: Number(decision.confidence) || 0,
    ts: now
  });
  const cutoff = now - 75_000;
  state.signalHistory = state.signalHistory.filter((item) => item.ts >= cutoff).slice(-40);
}

function stabilizeDecision(decision) {
  const now = Date.now();
  const held = state.heldDecision;
  const action = decision.action;
  const isTradeCall = ['OVER', 'UNDER'].includes(action);
  const heldIsTradeCall = held && ['OVER', 'UNDER'].includes(held.action);
  const remainingSec = getRemainingSec();
  const holdMs = remainingSec <= 360 ? STRONG_HOLD_MS : remainingSec <= 600 ? ENTRY_HOLD_MS : BASE_HOLD_MS;

  if (!heldIsTradeCall && isTradeCall) {
    state.pendingSwitch = null;
    state.heldDecision = { ...decision, heldAt: now, updatedAt: now, expiresAt: now + holdMs, bestConfidence: Number(decision.confidence) || 0 };
    return state.heldDecision;
  }

  if (heldIsTradeCall && isTradeCall && action === held.action) {
    state.pendingSwitch = null;
    const bestConfidence = Math.max(Number(held.bestConfidence || held.confidence || 0), Number(decision.confidence || 0));
    state.heldDecision = {
      ...decision,
      heldAt: held.heldAt || now,
      updatedAt: now,
      expiresAt: now + holdMs,
      bestConfidence
    };
    return state.heldDecision;
  }

  if (heldIsTradeCall && isTradeCall && action !== held.action) {
    if (held.expiresAt <= now) {
      state.pendingSwitch = null;
      state.heldDecision = { ...decision, heldAt: now, updatedAt: now, expiresAt: now + holdMs, bestConfidence: Number(decision.confidence) || 0 };
      return state.heldDecision;
    }

    const pending = state.pendingSwitch?.action === action
      ? state.pendingSwitch
      : { action, startedAt: now, strongestConfidence: 0, lowestFlipRisk: 100 };
    pending.strongestConfidence = Math.max(pending.strongestConfidence, Number(decision.confidence || 0));
    pending.lowestFlipRisk = Math.min(pending.lowestFlipRisk, Number(decision.flipRisk || 100));
    state.pendingSwitch = pending;

    const pendingForMs = now - pending.startedAt;
    const confidenceLead = Number(decision.confidence || 0) - Number(held.confidence || 0);
    const flipImprovement = Number(held.flipRisk || 100) - Number(decision.flipRisk || 100);
    const immediateOverride = Number(decision.confidence || 0) >= 90 && Number(decision.flipRisk || 100) <= 24 && confidenceLead >= 14;
    const confirmedSwitch = pendingForMs >= SWITCH_CONFIRM_MS && confidenceLead >= 12 && flipImprovement >= 5;

    if (immediateOverride || confirmedSwitch) {
      state.pendingSwitch = null;
      state.heldDecision = { ...decision, heldAt: now, updatedAt: now, expiresAt: now + holdMs, bestConfidence: Number(decision.confidence) || 0 };
      return state.heldDecision;
    }

    return {
      ...held,
      held: true,
      rawAction: action,
      rawChoice: decision.choice,
      confidence: Math.max(Number(held.confidence || 0) - 1.5, Number(decision.confidence || 0) - 6, 1),
      stability: Math.max(Number(held.stability || 0), Number(decision.stability || 0)),
      flipRisk: Math.min(99, Math.max(Number(held.flipRisk || 0), Number(decision.flipRisk || 0))),
      readiness: `Prediction lock: holding ${held.action}. ${action} must stay stronger for ${Math.max(0, Math.ceil((SWITCH_CONFIRM_MS - pendingForMs) / 1000))} more seconds before switching.`,
      reasons: [
        `Held ${held.action} instead of switching on one noisy update.`,
        ...(decision.reasons || [])
      ]
    };
  }

  if (heldIsTradeCall && !isTradeCall) {
    const canHold = held.expiresAt > now &&
      (decision.choice === held.choice || decision.choice === held.action || Number(decision.confidence || 0) >= Number(held.confidence || 0) - 24) &&
      Number(decision.flipRisk || 100) <= Math.max(Number(held.flipRisk || 0) + 30, 78);

    if (canHold) {
      return {
        ...held,
        held: true,
        rawAction: decision.action,
        rawChoice: decision.choice,
        confidence: Math.max(Number(held.confidence || 0) - 1, Number(decision.confidence || 0), 1),
        stability: Math.max(Number(held.stability || 0), Number(decision.stability || 0)),
        flipRisk: Math.min(99, Math.max(Number(held.flipRisk || 0), Number(decision.flipRisk || 0))),
        readiness: `Prediction lock: holding ${held.action}. The raw engine briefly said ${decision.action}, but the call has not been invalidated yet.`,
        reasons: [
          `Held ${held.action} instead of flickering to ${decision.action}.`,
          ...(decision.reasons || [])
        ]
      };
    }
  }

  if (!isTradeCall) {
    state.pendingSwitch = null;
    state.heldDecision = null;
  }
  return decision;
}

function renderDecision(decision) {
  const action = decision.action || 'WAIT';
  $('mainAction').textContent = action;
  $('mainAction').className = `main-action ${action.toLowerCase()}`;
  $('readiness').textContent = decision.readiness || '';
  $('confidence').textContent = fmtPct(decision.confidence);
  $('stability') && ($('stability').textContent = fmtPct(decision.stability));
  $('flipRisk').textContent = fmtPct(decision.flipRisk);
  $('checkpoint').textContent = `${decision.checkpoint || '—'}m`;
  const timing = getTimingSignal(decision);
  const entryQualityEl = $('entryQuality');
  if (entryQualityEl) entryQualityEl.textContent = fmtPct(timing.entryQuality);
  const fairPriceEl = $('fairPrice');
  if (fairPriceEl) fairPriceEl.textContent = decision.marketValue?.price ? `${decision.marketValue.price}¢` : '—';
  renderTimingEngine(timing);
  renderLearningEngine();
  renderEntryMinuteTracker();
  const raw = state.rawDecision;
  const rawText = raw ? `${raw.action || 'WAIT'} (${fmtPct(raw.confidence)})` : '—';
  const lockedText = ['OVER', 'UNDER'].includes(decision.action)
    ? `${decision.action}${decision.held ? ' locked' : ' active'}`
    : '—';
  const rawEl = $('rawSignal');
  const lockEl = $('lockedPrediction');
  const trackerEl = $('trackerLock');
  if (rawEl) rawEl.textContent = rawText;
  if (lockEl) lockEl.textContent = lockedText;
  if (trackerEl) trackerEl.textContent = formatOfficialLock(state.currentLadder?.officialCall);
}

function renderMarketBasics() {
  const latest = state.ticks.at(-1);
  $('btcPrice').textContent = latest ? fmtMoney(latest.price) : '—';
  $('targetDisplay').textContent = Number($('targetPrice').value) ? fmtMoney(Number($('targetPrice').value)) : '—';
  $('timeLeftDisplay').textContent = formatRemaining(getRemainingSec());
  const yes = state.orderbook?.yesPrice ?? state.coinbasePrediction?.yesPrice ?? state.market?.yes_bid ?? state.market?.yes_ask ?? state.market?.last_price;
  const no = state.orderbook?.noPrice ?? state.coinbasePrediction?.noPrice ?? state.market?.no_bid ?? state.market?.no_ask;
  const predContext = getPredictionPriceContext();
  const yesEl = $('yesPrice');
  const noEl = $('noPrice');
  if (yesEl) yesEl.textContent = yes ? `${displayCents(yes)}${formatSignedChange(predContext.yesChange, '¢')}` : '—';
  if (noEl) noEl.textContent = no ? `${displayCents(no)}${formatSignedChange(predContext.noChange, '¢')}` : '—';
}

function renderReasons(decision) {
  $('reasons').innerHTML = (decision.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
}

function renderIndicators(indicators) {
  $('indicators').innerHTML = Object.entries(indicators).map(([key, value]) =>
    `<div><span class="small-muted">${escapeHtml(key)}</span><strong>${escapeHtml(String(value))}</strong></div>`
  ).join('');
}

function renderLadder() {
  const currentCp = state.decision?.checkpoint;
  $('ladder').innerHTML = CHECKPOINT_MINUTES.map((minutes) => {
    const captured = state.capturedCheckpoints[String(minutes)];
    const active = currentCp === minutes ? ' active' : '';
    return `<div class="checkpoint-card${active}">
      <div class="checkpoint-time">${minutes}:00 left</div>
      <div class="checkpoint-pick">${captured ? captured.action : '—'}</div>
      <div class="checkpoint-details">${captured ? `${captured.confidence}% conf · ${captured.flipRisk}% flip` : 'Waiting'}</div>
    </div>`;
  }).join('');
}


function updatePredictionPriceHistory(data) {
  const yes = Number(data?.yesPrice);
  const no = Number(data?.noPrice);
  if (!Number.isFinite(yes) && !Number.isFinite(no)) return;
  state.predictionPriceHistory.push({
    ts: Date.now(),
    ticker: data.ticker || 'COINBASE-BTC-15M',
    yesPrice: Number.isFinite(yes) ? (yes > 1 ? yes : yes * 100) : null,
    noPrice: Number.isFinite(no) ? (no > 1 ? no : no * 100) : null
  });
  const cutoff = Date.now() - 20 * 60 * 1000;
  state.predictionPriceHistory = state.predictionPriceHistory.filter((item) => item.ts >= cutoff).slice(-120);
}

function getPredictionPriceContext() {
  const last = state.predictionPriceHistory.at(-1);
  if (!last) return { yesChange: 0, noChange: 0, predictionSamples: 0 };
  const sameTicker = state.predictionPriceHistory.filter((item) => item.ticker === last.ticker);
  const prior = sameTicker.find((item) => last.ts - item.ts >= 55_000) || sameTicker[0] || last;
  const yesChange = Number.isFinite(last.yesPrice) && Number.isFinite(prior.yesPrice) ? last.yesPrice - prior.yesPrice : 0;
  const noChange = Number.isFinite(last.noPrice) && Number.isFinite(prior.noPrice) ? last.noPrice - prior.noPrice : 0;
  return { yesChange, noChange, predictionSamples: sameTicker.length };
}

function getMicrostructureContext() {
  const now = Date.now();
  const recent60 = state.ticks.filter((tick) => tick.ts >= now - 60_000);
  const recent30 = state.ticks.filter((tick) => tick.ts >= now - 30_000);
  const latest = state.ticks.at(-1);
  const withSpread = [...state.ticks].reverse().find((tick) => Number.isFinite(Number(tick.spread)) && Number(tick.spread) >= 0);
  const upMoves = recent30.filter((tick, index, arr) => index > 0 && tick.price > arr[index - 1].price).length;
  const downMoves = recent30.filter((tick, index, arr) => index > 0 && tick.price < arr[index - 1].price).length;
  const buys = recent60.filter((tick) => ['BUY', 'BID'].includes(String(tick.side || '').toUpperCase())).length;
  const sells = recent60.filter((tick) => ['SELL', 'ASK'].includes(String(tick.side || '').toUpperCase())).length;
  const tradeVelocity = recent60.length / 60;
  const tickPressure = recent30.length > 1 ? (upMoves - downMoves) / Math.max(upMoves + downMoves, 1) : 0;
  const buySellPressure = buys + sells ? (buys - sells) / (buys + sells) : 0;
  const remainingSec = getRemainingSec();
  const elapsedMs = Math.max(0, (15 * 60 - remainingSec) * 1000);
  const windowStart = latest ? latest.ts - elapsedMs : now;
  const currentWindowTicks = state.ticks.filter((tick) => tick.ts >= windowStart);
  const windowPrices = currentWindowTicks.map((tick) => tick.price);
  const periodHigh = windowPrices.length ? Math.max(...windowPrices) : latest?.price ?? null;
  const periodLow = windowPrices.length ? Math.min(...windowPrices) : latest?.price ?? null;
  return {
    bestBid: withSpread?.bestBid ?? null,
    bestAsk: withSpread?.bestAsk ?? null,
    spread: withSpread?.spread ?? null,
    tradeVelocity,
    tickPressure,
    buySellPressure,
    periodHigh,
    periodLow,
    periodRange: Number.isFinite(periodHigh) && Number.isFinite(periodLow) ? periodHigh - periodLow : null
  };
}

function ensureCurrentLadder() {
  const targetPrice = Number($('targetPrice').value);
  const closeTime = getActiveCloseTime();
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !closeTime) return null;
  const ticker = $('marketTicker').value || state.market?.ticker || state.market?.market_ticker || state.localPrediction?.ticker || 'COINBASE-BTC15M';
  const windowKey = `${ticker}|${targetPrice}|${new Date(closeTime).toISOString()}`;
  if (state.currentLadder?.windowKey === windowKey) return state.currentLadder;

  if (state.currentLadder && !state.currentLadder.settledAt) finalizeCurrentLadder('window_changed');

  state.currentLadder = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    windowKey,
    ticker,
    title: state.market?.title || state.localPrediction?.title || state.coinbasePrediction?.title || 'BTC 15 min',
    targetPrice,
    closeTime: new Date(closeTime).toISOString(),
    startedAt: Date.now(),
    profile: PROFILES[$('profileSelect').value]?.label || $('profileSelect').value || 'Balanced',
    profileKey: $('profileSelect').value || 'balanced',
    checkpoints: {},
    entryMinutes: {},
    lastCall: null,
    officialCall: null,
    lastSeenPrice: state.ticks.at(-1)?.price ?? null
  };
  saveCurrentLadder();
  return state.currentLadder;
}

function getActiveCloseTime() {
  const now = Date.now();
  const preferred = hasFreshCoinbasePrediction(now) ? state.coinbasePrediction : state.localPrediction;
  if (preferred?.closeTime) {
    const parsed = Date.parse(preferred.closeTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (state.market) {
    const parsed = parseMarketCloseTime(state.market);
    if (parsed) return parsed;
  }
  if (state.manualEndAt && state.manualEndAt > now) return state.manualEndAt;
  return null;
}

function updateCurrentLadderDecision(decision) {
  const ladder = ensureCurrentLadder();
  if (!ladder || !decision) return;
  ladder.lastSeenPrice = state.ticks.at(-1)?.price ?? ladder.lastSeenPrice;
  const action = ['OVER', 'UNDER'].includes(decision.action) ? decision.action : null;
  if (action) {
    ladder.lastCall = {
      action,
      choice: decision.choice,
      confidence: decision.confidence,
      stability: decision.stability,
      flipRisk: decision.flipRisk,
      checkpoint: decision.checkpoint,
      ts: Date.now(),
      held: Boolean(decision.held)
    };
  }
  saveCurrentLadder();
}


function getHeldDurationMs(decision) {
  const heldAt = Number(decision?.heldAt || state.heldDecision?.heldAt || 0);
  return heldAt ? Math.max(0, Date.now() - heldAt) : 0;
}

function getOfficialLockCandidate(decision, remainingSec) {
  if (!decision || !['OVER', 'UNDER'].includes(decision.action)) return { allow: false, reason: 'No trade call' };
  const timing = getTimingSignal(decision);
  const confidence = Number(decision.confidence || 0);
  const flipRisk = Number(decision.flipRisk || 100);
  const stability = Number(decision.stability || 0);
  const entryQuality = Number(timing.entryQuality || 0);
  const heldMs = getHeldDurationMs(decision);
  const minute = Math.max(1, Math.min(15, Math.ceil(remainingSec / 60)));

  const baseClean = confidence >= 52 && flipRisk <= 68 && stability >= 34;
  const priority6m = remainingSec <= 420 && remainingSec >= 300 && baseClean && entryQuality >= 52;
  const earlyStrong = remainingSec <= 540 && remainingSec > 420 && confidence >= 62 && flipRisk <= 52 && entryQuality >= 70 && heldMs >= 30000;
  const lateStrong = remainingSec < 300 && remainingSec >= 120 && confidence >= 72 && flipRisk <= 42 && entryQuality >= 72;
  const emergency = confidence >= 88 && flipRisk <= 25 && entryQuality >= 82;

  if (priority6m) return { allow: true, source: '6m priority lock', minute, entryQuality, heldMs };
  if (earlyStrong) return { allow: true, source: 'early strong lock', minute, entryQuality, heldMs };
  if (lateStrong) return { allow: true, source: 'late strong lock', minute, entryQuality, heldMs };
  if (emergency) return { allow: true, source: 'emergency lock', minute, entryQuality, heldMs };
  return { allow: false, reason: 'Waiting for official lock', minute, entryQuality, heldMs };
}

function maybeLockOfficialCall(decision, remainingSec) {
  const ladder = ensureCurrentLadder();
  if (!ladder || ladder.officialCall) return;
  const candidate = getOfficialLockCandidate(decision, remainingSec);
  if (!candidate.allow) return;
  ladder.officialCall = {
    action: decision.action,
    choice: decision.choice || decision.action,
    minute: candidate.minute,
    checkpoint: nearestCheckpointFallback(remainingSec),
    source: candidate.source,
    confidence: Number(decision.confidence || 0),
    stability: Number(decision.stability || 0),
    flipRisk: Number(decision.flipRisk || 100),
    entryQuality: Number(candidate.entryQuality || 0),
    heldMs: Number(candidate.heldMs || 0),
    profile: PROFILES[$('profileSelect').value]?.label || $('profileSelect').value || 'Balanced',
    profileKey: $('profileSelect').value || 'balanced',
    price: state.ticks.at(-1)?.price ?? null,
    targetPrice: Number($('targetPrice').value),
    lockedAt: Date.now(),
    trackerLockVersion: TRACKER_LOCK_VERSION,
    liveReturn: captureLiveReturnAtLock(decision.action)
  };
  saveCurrentLadder();
  renderLiveReturnTracker();
}

function formatOfficialLock(lock) {
  if (!lock) return 'Waiting for tracker lock';
  return `${lock.action} · ${lock.minute}m · ${lock.source}`;
}

function updateCurrentLadderCheckpoint(cp, decision) {
  const ladder = ensureCurrentLadder();
  if (!ladder) return;
  ladder.checkpoints[String(cp)] = {
    action: decision.action,
    choice: decision.choice,
    confidence: decision.confidence,
    stability: decision.stability,
    flipRisk: decision.flipRisk,
    held: Boolean(decision.held),
    capturedAt: decision.capturedAt || Date.now()
  };
  if (['OVER', 'UNDER'].includes(decision.action)) {
    ladder.lastCall = { ...ladder.checkpoints[String(cp)], checkpoint: cp, ts: Date.now() };
  }
  saveCurrentLadder();
}


function captureEntryMinuteSnapshot(decision, remainingSec) {
  const ladder = ensureCurrentLadder();
  if (!ladder || !decision || !Number.isFinite(remainingSec) || remainingSec <= 0) return;
  const minute = Math.max(1, Math.min(15, Math.ceil(remainingSec / 60)));
  const key = String(minute);
  if (state.capturedEntryMinutes[key] || ladder.entryMinutes?.[key]) return;
  const timing = getTimingSignal(decision);
  const snapshot = {
    minute,
    action: decision.action || 'SKIP',
    choice: decision.choice || decision.action || 'SKIP',
    confidence: Number(decision.confidence || 0),
    stability: Number(decision.stability || 0),
    flipRisk: Number(decision.flipRisk || 100),
    entryQuality: Number(timing.entryQuality || 0),
    moneyScore: estimateMinuteMoneyScore(decision, timing, minute),
    profile: PROFILES[$('profileSelect').value]?.label || $('profileSelect').value || 'Balanced',
    profileKey: $('profileSelect').value || 'balanced',
    price: state.ticks.at(-1)?.price ?? null,
    targetPrice: Number($('targetPrice').value),
    capturedAt: Date.now()
  };
  state.capturedEntryMinutes[key] = snapshot;
  ladder.entryMinutes = { ...(ladder.entryMinutes || {}), [key]: snapshot };
  saveCurrentLadder();
}

function estimateMinuteMoneyScore(decision, timing, minute) {
  if (!decision || !['OVER', 'UNDER'].includes(decision.action)) return 0;
  const confidence = Number(decision.confidence || 0);
  const flipRisk = Number(decision.flipRisk || 100);
  const entryQuality = Number(timing?.entryQuality || 0);
  const earlyPremium = clampClient(((minute - 1) / 14) * 100, 0, 100);
  const sixMinuteBonus = Math.max(0, 100 - Math.abs(minute - 6) * 18);
  return Math.round((entryQuality * 0.44 + confidence * 0.16 + (100 - flipRisk) * 0.18 + earlyPremium * 0.12 + sixMinuteBonus * 0.10) * 10) / 10;
}

function scoreEntryMinutes(entryMinutes = {}, finalSide = 'PUSH') {
  const scored = {};
  for (const minute of ENTRY_MINUTES) {
    const item = entryMinutes?.[String(minute)];
    if (!item) continue;
    const action = item.action || 'SKIP';
    let score = 'empty';
    let marker = '';
    let realizedScore = 0;
    if (action === 'SKIP') { score = 'skip'; marker = 'skip'; }
    else if (['OVER', 'UNDER'].includes(action) && finalSide !== 'PUSH') {
      score = action === finalSide ? 'correct' : 'wrong';
      marker = action === finalSide ? '✓' : '✕';
      realizedScore = (action === finalSide ? 1 : -1) * Number(item.moneyScore || 0);
    } else if (['OVER', 'UNDER'].includes(action) && finalSide === 'PUSH') {
      score = 'push'; marker = 'push';
    }
    scored[String(minute)] = { ...item, score, marker, realizedScore };
  }
  return scored;
}

function finalizeCurrentLadder(reason = 'closed') {
  const ladder = state.currentLadder;
  if (!ladder || ladder.settledAt) return null;
  const close = Date.parse(ladder.closeTime);
  if (Number.isFinite(close) && close - Date.now() > 2500 && reason !== 'window_changed' && reason !== 'new_window') return null;

  const finalPrice = state.ticks.at(-1)?.price ?? ladder.lastSeenPrice;
  const targetPrice = Number(ladder.targetPrice);
  if (!Number.isFinite(finalPrice) || !Number.isFinite(targetPrice)) return null;

  const finalSide = finalPrice > targetPrice ? 'OVER' : finalPrice < targetPrice ? 'UNDER' : 'PUSH';
  const officialCall = ladder.officialCall || null;
  const recommendation = officialCall?.action || 'SKIP';
  const callSource = officialCall ? `${officialCall.minute}m ${officialCall.source}` : 'no official tracker lock';
  const result = finalSide === 'PUSH' ? 'void' : recommendation === 'SKIP' ? 'skipped' : recommendation === finalSide ? 'win' : 'loss';
  const scoredCheckpoints = scoreLadderCheckpoints(ladder.checkpoints, finalSide);
  const scoredEntryMinutes = scoreEntryMinutes(ladder.entryMinutes || {}, finalSide);

  const completed = {
    ...ladder,
    recommendation,
    result,
    finalSide,
    finalPrice: Number(finalPrice),
    callSource,
    scoredCheckpoints,
    scoredEntryMinutes,
    settledAt: Date.now(),
    settleReason: reason
  };

  const alreadySaved = state.ladders.some((item) => item.windowKey === completed.windowKey);
  if (!alreadySaved) state.ladders.unshift(completed);
  state.ladders = state.ladders.slice(0, 25);
  saveLadders();
  addAutoRecordFromLadder(completed);
  state.currentLadder = null;
  localStorage.removeItem(CURRENT_LADDER_KEY);
  renderCompletedLadders();
  renderRecords();
  renderStats();
  return completed;
}

function addAutoRecordFromLadder(ladder) {
  if (!ladder || state.records.some((record) => record.windowKey === ladder.windowKey && record.recordType === 'auto_ladder')) return;
  const call = ladder.officialCall || {};
  const record = {
    id: `${ladder.id}-auto`,
    ts: ladder.settledAt || Date.now(),
    recordType: 'auto_ladder',
    windowKey: ladder.windowKey,
    ticker: ladder.ticker,
    title: ladder.title,
    targetPrice: ladder.targetPrice,
    currentPrice: call.price || null,
    checkpoint: call.minute ? `${call.minute}m lock` : 'no lock',
    profileKey: call.profileKey || ladder.profileKey,
    profile: call.profile || ladder.profile,
    recommendation: ladder.recommendation,
    choice: ladder.recommendation,
    confidence: call.confidence || null,
    stability: call.stability || null,
    flipRisk: call.flipRisk || null,
    userEntry: 'auto-ladder',
    result: ladder.result,
    finalSide: ladder.finalSide,
    finalPrice: ladder.finalPrice,
    settledAt: ladder.settledAt,
    reasons: [`Auto-scored completed 15-minute ladder. Final period ended ${ladder.finalSide}.`],
    checkpoints: ladder.checkpoints || {},
    entryMinutes: ladder.entryMinutes || {},
    officialCall: ladder.officialCall || null,
    callSource: ladder.callSource || 'no official tracker lock',
    trackerLockVersion: TRACKER_LOCK_VERSION,
    liveReturn: ladder.officialCall?.liveReturn || null,
    realizedReturn: settleLiveReturn(ladder.officialCall?.liveReturn, ladder.result)
  };
  state.records.unshift(record);
  state.records = state.records.slice(0, 500);
  saveRecords();
}

function renderCompletedLadders() {
  const container = $('completedLadders');
  if (!container) return;
  if (!state.ladders.length) {
    container.innerHTML = '<div class="small-muted">No completed 15-minute ladders yet. Leave the app open through a full period and it will score the final Over/Under automatically.</div>';
    renderLadderStats();
    return;
  }
  container.innerHTML = state.ladders.slice(0, COMPLETED_LADDER_LIMIT).map((ladder) => {
    const scored = ladder.scoredCheckpoints || scoreLadderCheckpoints(ladder.checkpoints, ladder.finalSide);
    const checkpoints = CHECKPOINT_MINUTES.map((minutes) => {
      const cp = scored[String(minutes)] || { action: '—', score: 'empty', marker: '' };
      const cls = String(cp.action || 'empty').toLowerCase();
      return `<div class="history-cp compact ${cls} ${cp.score}"><span>${minutes}m</span><strong>${escapeHtml(cp.action || '—')}</strong><em>${escapeHtml(cp.marker || '')}</em></div>`;
    }).join('');
    const resultClass = ladder.result === 'win' ? 'good' : ladder.result === 'loss' ? 'bad' : 'warn';
    const source = ladder.callSource ? ` · Lock: ${escapeHtml(ladder.callSource)}` : '';
    const entryBest = getLadderBestEntryMinute(ladder);
    return `<div class="ladder-record compact-record">
      <div class="ladder-record-head compact-head">
        <div>
          <strong>${escapeHtml(ladder.recommendation || 'SKIP')} · ${escapeHtml((ladder.result || 'open').toUpperCase())}</strong>
          <span class="small-muted">${new Date(ladder.settledAt || ladder.startedAt).toLocaleTimeString()} · T ${fmtMoney(ladder.targetPrice)} · F ${fmtMoney(ladder.finalPrice)} · Best entry ${escapeHtml(entryBest)}${source}</span>
        </div>
        <div class="final-badge ${resultClass}">Ended ${escapeHtml(ladder.finalSide || '—')}</div>
      </div>
      <div class="history-ladder compact-grid">${checkpoints}</div>
    </div>`;
  }).join('');
  renderLadderStats();
}


function getLadderBestEntryMinute(ladder) {
  if (!ladder || !ladder.finalSide || ladder.finalSide === 'PUSH') return '—';
  const scored = ladder.scoredEntryMinutes || scoreEntryMinutes(ladder.entryMinutes || {}, ladder.finalSide);
  const candidates = Object.values(scored).filter((item) => item.score === 'correct');
  if (!candidates.length) return '—';
  candidates.sort((a, b) => Number(b.realizedScore || 0) - Number(a.realizedScore || 0) || Number(b.minute || 0) - Number(a.minute || 0));
  const best = candidates[0];
  return `${best.minute}m ${best.action}`;
}

function scoreLadderCheckpoints(checkpoints = {}, finalSide = 'PUSH') {
  const scored = {};
  for (const minutes of CHECKPOINT_MINUTES) {
    const cp = checkpoints?.[String(minutes)];
    const action = cp?.action || '—';
    let score = 'empty';
    let marker = '';
    if (action === 'SKIP') { score = 'skip'; marker = 'skip'; }
    else if (['OVER', 'UNDER'].includes(action) && finalSide !== 'PUSH') {
      score = action === finalSide ? 'correct' : 'wrong';
      marker = action === finalSide ? '✓' : '✕';
    } else if (['OVER', 'UNDER'].includes(action) && finalSide === 'PUSH') {
      score = 'push'; marker = 'push';
    }
    scored[String(minutes)] = { ...(cp || {}), action, score, marker };
  }
  return scored;
}

function summarizeLadderAccuracy(ladders = state.ladders) {
  const summary = {
    byCheckpoint: Object.fromEntries(CHECKPOINT_MINUTES.map((m) => [String(m), { calls: 0, correct: 0, wrong: 0, skips: 0, accuracy: 0, skipRate: 0 }])),
    bySide: { OVER: { calls: 0, correct: 0, wrong: 0, accuracy: 0 }, UNDER: { calls: 0, correct: 0, wrong: 0, accuracy: 0 } }
  };
  for (const ladder of ladders) {
    if (!ladder || ladder.finalSide === 'PUSH') continue;
    const scored = ladder.scoredCheckpoints || scoreLadderCheckpoints(ladder.checkpoints, ladder.finalSide);
    for (const minutes of CHECKPOINT_MINUTES) {
      const bucket = summary.byCheckpoint[String(minutes)];
      const cp = scored[String(minutes)];
      const action = cp?.action;
      if (action === 'SKIP') { bucket.skips += 1; continue; }
      if (!['OVER', 'UNDER'].includes(action)) continue;
      bucket.calls += 1;
      summary.bySide[action].calls += 1;
      if (action === ladder.finalSide) {
        bucket.correct += 1;
        summary.bySide[action].correct += 1;
      } else {
        bucket.wrong += 1;
        summary.bySide[action].wrong += 1;
      }
    }
  }
  for (const bucket of Object.values(summary.byCheckpoint)) {
    bucket.accuracy = bucket.calls ? Math.round((bucket.correct / bucket.calls) * 1000) / 10 : 0;
    const totalSeen = bucket.calls + bucket.skips;
    bucket.skipRate = totalSeen ? Math.round((bucket.skips / totalSeen) * 1000) / 10 : 0;
  }
  for (const bucket of Object.values(summary.bySide)) {
    bucket.accuracy = bucket.calls ? Math.round((bucket.correct / bucket.calls) * 1000) / 10 : 0;
  }
  return summary;
}


function summarizeEntryMinuteTracker(ladders = state.ladders) {
  const summary = Object.fromEntries(ENTRY_MINUTES.map((minute) => [String(minute), {
    minute,
    calls: 0,
    correct: 0,
    wrong: 0,
    skips: 0,
    accuracy: 0,
    avgEntryQuality: 0,
    avgMoneyScore: 0,
    avgRealizedScore: 0,
    bestProfile: '—',
    profileCounts: {}
  }]));

  for (const ladder of ladders) {
    if (!ladder || !ladder.finalSide || ladder.finalSide === 'PUSH') continue;
    const scored = ladder.scoredEntryMinutes || scoreEntryMinutes(ladder.entryMinutes || {}, ladder.finalSide);
    for (const minute of ENTRY_MINUTES) {
      const bucket = summary[String(minute)];
      const item = scored[String(minute)];
      if (!item) continue;
      const action = item.action || 'SKIP';
      if (action === 'SKIP') { bucket.skips += 1; continue; }
      if (!['OVER', 'UNDER'].includes(action)) continue;
      bucket.calls += 1;
      bucket.avgEntryQuality += Number(item.entryQuality || 0);
      bucket.avgMoneyScore += Number(item.moneyScore || 0);
      bucket.avgRealizedScore += Number(item.realizedScore || 0);
      const profile = item.profile || ladder.profile || 'Unknown';
      bucket.profileCounts[profile] = (bucket.profileCounts[profile] || 0) + 1;
      if (action === ladder.finalSide) bucket.correct += 1;
      else bucket.wrong += 1;
    }
  }

  for (const bucket of Object.values(summary)) {
    if (bucket.calls) {
      bucket.accuracy = Math.round((bucket.correct / bucket.calls) * 1000) / 10;
      bucket.avgEntryQuality = Math.round((bucket.avgEntryQuality / bucket.calls) * 10) / 10;
      bucket.avgMoneyScore = Math.round((bucket.avgMoneyScore / bucket.calls) * 10) / 10;
      bucket.avgRealizedScore = Math.round((bucket.avgRealizedScore / bucket.calls) * 10) / 10;
      bucket.bestProfile = Object.entries(bucket.profileCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
    }
    delete bucket.profileCounts;
  }
  return summary;
}

function getBestEntryMinuteSummary() {
  const stats = summarizeEntryMinuteTracker();
  const candidates = Object.values(stats).filter((item) => item.calls >= 2);
  const bestMoney = candidates.slice().sort((a, b) => b.avgRealizedScore - a.avgRealizedScore || b.accuracy - a.accuracy)[0];
  const bestAccuracy = candidates.slice().sort((a, b) => b.accuracy - a.accuracy || b.calls - a.calls)[0];
  const bestEarly = candidates.filter((item) => item.minute >= 8).sort((a, b) => b.avgRealizedScore - a.avgRealizedScore || b.accuracy - a.accuracy)[0];
  return {
    stats,
    bestMoney,
    bestAccuracy,
    bestEarly,
    bestWindow: bestMoney ? `${bestMoney.minute}m` : '6m priority',
    summaryLabel: bestMoney ? `${bestMoney.minute}m · ${bestMoney.accuracy}% · ${bestMoney.avgRealizedScore}` : 'Waiting'
  };
}

function renderEntryMinuteTracker() {
  const el = $('entryMinuteTracker');
  if (!el) return;
  const { bestMoney, bestAccuracy, bestEarly, stats } = getBestEntryMinuteSummary();
  const top = Object.values(stats)
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.avgRealizedScore - a.avgRealizedScore || b.accuracy - a.accuracy)
    .slice(0, 4);
  const rows = [
    ['Best money', bestMoney ? `${bestMoney.minute}m · ${bestMoney.avgRealizedScore}` : 'Waiting'],
    ['Best win %', bestAccuracy ? `${bestAccuracy.minute}m · ${bestAccuracy.accuracy}%` : 'Waiting'],
    ['Best early', bestEarly ? `${bestEarly.minute}m · ${bestEarly.accuracy}%` : 'Waiting'],
    ['6m priority', formatEntryMinuteStat(stats['6'])]
  ];
  const topRows = top.map((item) => `<div class="mini-row entry-minute-best"><strong>${item.minute}m</strong><span>${item.correct}/${item.calls}</span><span>${item.accuracy}%</span><span>${item.avgRealizedScore}</span></div>`).join('');
  el.innerHTML = rows.map(([label, value]) => `<div class="mini-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`).join('') + (topRows ? `<div class="section-subtitle tight">Top minutes</div>${topRows}` : '');
}

function formatEntryMinuteStat(item) {
  if (!item || !item.calls) return 'Waiting';
  return `${item.correct}/${item.calls} · ${item.accuracy}% · ${item.avgRealizedScore}`;
}

function renderLadderStats() {
  const checkpointEl = $('checkpointAccuracy');
  const sideEl = $('sideAccuracy');
  if (!checkpointEl || !sideEl) return;
  const summary = summarizeLadderAccuracy();
  checkpointEl.innerHTML = CHECKPOINT_MINUTES.map((minutes) => {
    const stats = summary.byCheckpoint[String(minutes)];
    return `<div class="mini-row"><strong>${minutes}m</strong><span>${stats.correct}/${stats.calls}</span><span>${stats.accuracy}%</span><span>Skip ${stats.skipRate}%</span></div>`;
  }).join('');
  sideEl.innerHTML = ['OVER', 'UNDER'].map((side) => {
    const stats = summary.bySide[side];
    return `<div class="mini-row"><strong>${side}</strong><span>${stats.correct}/${stats.calls}</span><span>${stats.accuracy}%</span><span>L ${stats.wrong}</span></div>`;
  }).join('');
  renderEntryMinuteTracker();
  renderLiveReturnTracker();
}


function getTimingSignal(decision = state.decision) {
  if (!decision) return { entryQuality: 0, action: 'WAIT', note: 'Waiting for signal', bestWindow: '8m–6m' };
  const remainingSec = getRemainingSec();
  const confidence = Number(decision.confidence || 0);
  const flipRisk = Number(decision.flipRisk || 100);
  const stability = Number(decision.stability || 0);
  const checkpoint = decision.checkpoint || nearestCheckpointFallback(remainingSec);
  const timingScore = scoreEntryTime(remainingSec);
  const entryQuality = clampClient(confidence * 0.42 + (100 - flipRisk) * 0.32 + stability * 0.18 + timingScore * 0.08, 0, 99);
  let action = 'WAIT';
  if (decision.action === 'SKIP') action = 'SKIP';
  else if (entryQuality >= 78 && remainingSec >= 240) action = 'ENTER';
  else if (entryQuality >= 66 && remainingSec >= 360) action = 'PREPARE';
  else if (entryQuality >= 68 && remainingSec >= 120) action = 'WAIT';
  else if (remainingSec < 120 && entryQuality < 84) action = 'NO CHASE';
  const bestWindow = getLearningSummary().bestEntryWindow || '6m priority';
  const note = action === 'ENTER' ? 'Good timing now'
    : action === 'PREPARE' ? 'Get ready'
    : action === 'NO CHASE' ? 'Too late unless planned'
    : action === 'SKIP' ? 'No clean entry'
    : 'Wait for cleaner entry';
  return { entryQuality: Math.round(entryQuality * 10) / 10, action, note, checkpoint, bestWindow };
}

function scoreEntryTime(remainingSec) {
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return 0;
  const minutes = remainingSec / 60;
  if (minutes >= 6 && minutes <= 8.5) return 100;
  if (minutes >= 4 && minutes < 6) return 86;
  if (minutes > 8.5 && minutes <= 10.5) return 74;
  if (minutes > 10.5 && minutes <= 12.5) return 58;
  if (minutes >= 2 && minutes < 4) return 48;
  return 24;
}

function renderTimingEngine(timing = getTimingSignal()) {
  const el = $('timingEngine');
  if (!el) return;
  el.innerHTML = [
    ['Action', timing.action],
    ['Entry quality', `${timing.entryQuality}%`],
    ['Best window', timing.bestWindow],
    ['Note', timing.note]
  ].map(([label, value]) => `<div class="mini-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`).join('');
}

function getLearningSummary() {
  const ladders = state.ladders.filter((ladder) => ladder && ladder.finalSide && ladder.finalSide !== 'PUSH');
  const stats = summarizeLadderAccuracy(ladders);
  const bestCheckpoint = CHECKPOINT_MINUTES
    .map((minutes) => ({ minutes, ...stats.byCheckpoint[String(minutes)] }))
    .filter((item) => item.calls >= 3)
    .sort((a, b) => b.accuracy - a.accuracy || b.calls - a.calls)[0];
  const bestSide = Object.entries(stats.bySide)
    .map(([side, bucket]) => ({ side, ...bucket }))
    .filter((item) => item.calls >= 3)
    .sort((a, b) => b.accuracy - a.accuracy || b.calls - a.calls)[0];
  const dangerous = CHECKPOINT_MINUTES
    .map((minutes) => ({ minutes, ...stats.byCheckpoint[String(minutes)] }))
    .filter((item) => item.calls >= 2)
    .sort((a, b) => a.accuracy - b.accuracy || b.wrong - a.wrong)[0];

  const earliestCounts = Object.fromEntries(CHECKPOINT_MINUTES.map((m) => [String(m), 0]));
  for (const ladder of ladders) {
    const scored = ladder.scoredCheckpoints || scoreLadderCheckpoints(ladder.checkpoints, ladder.finalSide);
    const firstCorrect = CHECKPOINT_MINUTES.find((minutes) => scored[String(minutes)]?.score === 'correct');
    if (firstCorrect) earliestCounts[String(firstCorrect)] += 1;
  }
  const bestEarly = Object.entries(earliestCounts).sort((a, b) => b[1] - a[1])[0];
  const minuteSummary = getBestEntryMinuteSummary();
  const bestEntryWindow = minuteSummary.bestMoney ? `${minuteSummary.bestMoney.minute}m` : (bestEarly && bestEarly[1] > 0 ? `${bestEarly[0]}m` : '6m priority');
  return {
    sampleSize: ladders.length,
    mode: ladders.length >= LEARNING_SAMPLE_TARGET ? 'Adaptive ready' : 'Tracking only',
    bestCheckpoint: bestCheckpoint ? `${bestCheckpoint.minutes}m ${bestCheckpoint.accuracy}%` : 'Waiting',
    bestSide: bestSide ? `${bestSide.side} ${bestSide.accuracy}%` : 'Waiting',
    dangerousCall: dangerous ? `${dangerous.minutes}m ${dangerous.accuracy}%` : 'Waiting',
    bestEntryWindow,
    bestMoneyMinute: minuteSummary.summaryLabel
  };
}

function renderLearningEngine() {
  const el = $('learningEngine');
  if (!el) return;
  const summary = getLearningSummary();
  el.innerHTML = [
    ['Mode', summary.mode],
    ['Samples', `${summary.sampleSize}/${LEARNING_SAMPLE_TARGET}`],
    ['Best marker', summary.bestCheckpoint],
    ['Best side', summary.bestSide],
    ['Watch', summary.dangerousCall],
    ['Best entry', summary.bestEntryWindow],
    ['Best money', summary.bestMoneyMinute]
  ].map(([label, value]) => `<div class="mini-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`).join('');
}

function copyVersionName() {
  const text = APP_VERSION_FILE;
  const status = $('copyStatus');
  navigator.clipboard?.writeText(text).then(() => {
    if (status) status.textContent = 'Copied';
    setTimeout(() => { if (status) status.textContent = ''; }, 1400);
  }).catch(() => {
    if (status) status.textContent = text;
  });
}

function clampClient(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function nearestCheckpointFallback(remainingSec) {
  const minutes = remainingSec / 60;
  let best = CHECKPOINT_MINUTES[0];
  let diff = Infinity;
  for (const cp of CHECKPOINT_MINUTES) {
    const d = Math.abs(cp - minutes);
    if (d < diff) { best = cp; diff = d; }
  }
  return best;
}

function drawSparkline() {
  const canvas = $('sparkline');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070a10';
  ctx.fillRect(0, 0, width, height);
  const latestTs = state.ticks.at(-1)?.ts || Date.now();
  let ticks = state.ticks.filter((tick) => tick.ts >= latestTs - 5 * 60 * 1000);
  if (ticks.length < 2) ticks = state.ticks.slice(-180);
  if (ticks.length < 2) {
    ctx.fillStyle = '#8e9db1';
    ctx.font = '22px system-ui';
    ctx.fillText('Waiting for live Coinbase ticks…', 24, 96);
    return;
  }
  const prices = ticks.map((tick) => tick.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = Math.max((max - min) * 0.1, 10);
  const lo = min - pad;
  const hi = max + pad;
  const xFor = (i) => i / (ticks.length - 1) * width;
  const yFor = (price) => height - ((price - lo) / (hi - lo)) * height;

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = i * height / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const target = Number($('targetPrice').value);
  if (Number.isFinite(target) && target > 0) {
    const y = yFor(target);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.8)';
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#71a7ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ticks.forEach((tick, i) => {
    const x = xFor(i);
    const y = yFor(tick.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(142,157,177,0.9)';
  ctx.font = '18px system-ui';
  ctx.fillText('5m', 10, height - 12);
  ctx.fillText('now', width - 50, height - 12);
}


async function loadCoinbasePrediction(silent = false) {
  const status = $('predictionStatus');
  if (status && !silent) {
    status.textContent = 'Predictions: loading';
    status.className = 'pill warn';
  }
  try {
    const response = await fetch('/api/coinbase/prediction-btc', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Coinbase prediction lookup failed');

    const previousKey = [state.coinbasePrediction?.ticker, state.coinbasePrediction?.targetPrice, state.coinbasePrediction?.closeTime].join('|');
    const nextKey = [data.ticker, data.targetPrice, data.closeTime].join('|');
    state.coinbasePrediction = data;
    state.market = {
      source: 'coinbase_predictions',
      ticker: data.ticker || 'COINBASE-BTC-15M',
      title: data.title,
      close_time: data.closeTime,
      yes_bid: data.yesPrice,
      no_bid: data.noPrice,
      indicativeOnly: true
    };
    applyPredictionToUi(data, { reset: previousKey !== nextKey, save: true, sourceLabel: 'coinbase auto' });
    evaluateAndRender(false);
    if (status) {
      const sourceNote = data.closeTimeSource === 'ticker' ? 'auto' : 'auto time est.';
      status.textContent = `Predictions: ${sourceNote}`;
      status.className = 'pill good';
    }
    const debug = $('apiDebug');
    if (debug) debug.textContent = `Coinbase Predictions: ${data.title} · closes ${new Date(data.closeTime).toLocaleTimeString()}`;
  } catch (error) {
    updateLocalPredictionFromTicks();
    if (status) {
      status.textContent = state.localPrediction ? 'Predictions: local auto' : 'Predictions: manual fallback';
      status.className = state.localPrediction ? 'pill good' : 'pill warn';
    }
    const debug = $('apiDebug');
    if (debug) {
      const fallback = state.localPrediction ? `Using local 15m window target ${fmtMoney(state.localPrediction.targetPrice)} · closes ${new Date(state.localPrediction.closeTime).toLocaleTimeString()}` : 'No local fallback yet; waiting for live BTC tick.';
      debug.textContent = `Coinbase Predictions scrape failed: ${error.message}. ${fallback}`;
    }
  }
}

function recordCurrentDecision(mode = 'decision') {
  if (!state.decision) evaluateAndRender();
  const decision = mode === 'skip' ? { ...state.decision, action: 'SKIP' } : state.decision;
  const tickerEl = $('marketTicker');
  const record = createRecord({ decision, market: state.market || { ticker: tickerEl?.value || '' }, userEntry: decision.action });
  record.checkpoints = { ...state.capturedCheckpoints };
  state.records.unshift(record);
  saveRecords();
  renderRecords();
  renderStats();
}


function captureLiveReturnAtLock(action) {
  const normalized = String(action || '').toUpperCase();
  if (!['OVER', 'UNDER'].includes(normalized)) {
    return { available: false, reason: 'No locked side', stake: ASSUMED_STAKE_DOLLARS };
  }
  const oddsPercent = getCurrentCoinbaseOddsForSide(normalized);
  if (!Number.isFinite(oddsPercent) || oddsPercent <= 0 || oddsPercent >= 100) {
    return {
      available: false,
      reason: 'Coinbase odds unavailable at lock',
      stake: ASSUMED_STAKE_DOLLARS,
      side: normalized,
      capturedAt: Date.now(),
      source: state.coinbasePrediction?.source || state.orderbook?.source || 'unavailable'
    };
  }
  const multiplier = 100 / oddsPercent;
  const winReturn = ASSUMED_STAKE_DOLLARS * multiplier;
  const winProfit = winReturn - ASSUMED_STAKE_DOLLARS;
  return {
    available: true,
    stake: ASSUMED_STAKE_DOLLARS,
    side: normalized,
    oddsPercent: round2(oddsPercent),
    multiplier: round2(multiplier),
    winReturn: round2(winReturn),
    winProfit: round2(winProfit),
    lossProfit: round2(-ASSUMED_STAKE_DOLLARS),
    capturedAt: Date.now(),
    source: state.coinbasePrediction?.source || state.orderbook?.source || 'coinbase_predictions',
    ticker: state.coinbasePrediction?.ticker || state.market?.ticker || ''
  };
}

function getCurrentCoinbaseOddsForSide(side) {
  const field = side === 'OVER' ? 'yesPrice' : 'noPrice';
  const candidates = [
    state.coinbasePrediction?.[field],
    state.orderbook?.[field],
    state.market?.[side === 'OVER' ? 'yes_bid' : 'no_bid'],
    state.predictionPriceHistory.at(-1)?.[field]
  ];
  for (const value of candidates) {
    const normalized = normalizePercentPrice(value);
    if (Number.isFinite(normalized) && normalized > 0 && normalized < 100) return normalized;
  }
  return null;
}

function normalizePercentPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;
  if (n > 1 && n < 100) return n;
  return null;
}

function settleLiveReturn(snapshot, result) {
  if (!snapshot?.available) {
    return { available: false, reason: snapshot?.reason || 'No Coinbase odds captured' };
  }
  const outcome = String(result || '').toLowerCase();
  if (outcome === 'win') {
    return {
      available: true,
      stake: snapshot.stake,
      returnAmount: snapshot.winReturn,
      profit: snapshot.winProfit,
      result: 'win'
    };
  }
  if (outcome === 'loss') {
    return {
      available: true,
      stake: snapshot.stake,
      returnAmount: 0,
      profit: snapshot.lossProfit,
      result: 'loss'
    };
  }
  return {
    available: true,
    stake: snapshot.stake,
    returnAmount: 0,
    profit: 0,
    result: outcome || 'skipped'
  };
}

function summarizeLiveReturns() {
  const records = getOfficialTrackerRecords();
  const tracked = records.filter((record) => record.liveReturn?.available && record.realizedReturn?.available && ['win', 'loss'].includes(record.result));
  const unavailable = records.filter((record) => !record.liveReturn?.available && ['win', 'loss'].includes(record.result));
  const stake = tracked.reduce((sum, record) => sum + Number(record.realizedReturn?.stake || ASSUMED_STAKE_DOLLARS), 0);
  const net = tracked.reduce((sum, record) => sum + Number(record.realizedReturn?.profit || 0), 0);
  const returns = tracked.reduce((sum, record) => sum + Number(record.realizedReturn?.returnAmount || 0), 0);
  const roi = stake > 0 ? (net / stake) * 100 : 0;
  const last = records.find((record) => record.liveReturn?.available) || null;
  return { tracked: tracked.length, unavailable: unavailable.length, stake, net, returns, roi, last };
}

function renderLiveReturnTracker() {
  const summary = summarizeLiveReturns();
  const stakeEl = $('returnStake');
  const trackedEl = $('returnTracked');
  const netEl = $('returnNet');
  const roiEl = $('returnRoi');
  const tableEl = $('liveReturnTracker');
  if (stakeEl) stakeEl.textContent = formatDollar(ASSUMED_STAKE_DOLLARS);
  if (trackedEl) trackedEl.textContent = String(summary.tracked);
  if (netEl) {
    netEl.textContent = formatDollarSigned(summary.net);
    netEl.className = summary.net > 0 ? 'good-text' : summary.net < 0 ? 'bad-text' : '';
  }
  if (roiEl) roiEl.textContent = `${summary.roi >= 0 ? '+' : ''}${summary.roi.toFixed(1)}%`;
  if (!tableEl) return;
  const last = summary.last?.liveReturn;
  const lastText = last?.available
    ? `${last.side} · ${last.oddsPercent}% · ${last.multiplier}x`
    : 'No live odds captured yet';
  tableEl.innerHTML = [
    ['Last lock', lastText],
    ['If win', last?.available ? `${formatDollar(last.winReturn)} return / ${formatDollarSigned(last.winProfit)}` : '—'],
    ['If loss', last?.available ? formatDollarSigned(last.lossProfit) : '—'],
    ['Odds missing', String(summary.unavailable)]
  ].map(([label, value]) => `<div class="mini-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`).join('');
}

function formatDollar(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function formatDollarSigned(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function renderRecords() {
  const container = $('records');
  if (!state.records.length) {
    container.innerHTML = '<div class="small-muted">No records yet. Record decisions to start tracking.</div>';
    return;
  }
  container.innerHTML = '';
  const template = $('recordTemplate');
  state.records.slice(0, 30).forEach((record) => {
    const node = template.content.cloneNode(true);
    const confidenceLabel = record.confidence === null || record.confidence === undefined ? 'auto' : `${record.confidence}%`;
    const typeLabel = record.recordType === 'auto_ladder' ? 'auto ladder' : 'manual';
    const finalLabel = record.finalSide ? ` · ended ${record.finalSide}` : '';
    const sourceLabel = record.callSource ? ` · ${record.callSource}` : '';
    const returnLabel = record.realizedReturn?.available ? ` · ${formatDollarSigned(record.realizedReturn.profit)}` : '';
    node.querySelector('.record-title').textContent = `${record.recommendation} · ${confidenceLabel} · ${record.result}${finalLabel}${returnLabel}`;
    node.querySelector('.record-meta').textContent = `${new Date(record.ts).toLocaleString()} · ${typeLabel} · ${record.profile} · ${record.checkpoint}${sourceLabel} · ${record.ticker || 'manual'}`;
    node.querySelectorAll('button[data-result]').forEach((button) => {
      button.addEventListener('click', () => settleAndRender(record.id, button.dataset.result));
    });
    container.appendChild(node);
  });
}

function settleAndRender(id, result) {
  const finalPrice = state.ticks.at(-1)?.price ?? null;
  state.records = state.records.map((record) => record.id === id ? settleRecord(record, result, finalPrice) : record);
  saveRecords();
  renderRecords();
  renderStats();
}

function getOfficialTrackerRecords() {
  return state.records.filter((record) => record.recordType === 'auto_ladder' && Number(record.trackerLockVersion || 0) >= TRACKER_LOCK_VERSION);
}

function renderStats() {
  const summary = summarizeRecords(getOfficialTrackerRecords());
  $('wins').textContent = summary.wins;
  $('losses').textContent = summary.losses;
  $('skipped').textContent = summary.skipped;
  $('winRate').textContent = `${summary.winRate}%`;
  const profileRows = Object.entries(summary.byProfile).map(([profile, stats]) =>
    `<div class="mini-row"><strong>${escapeHtml(profile)}</strong><span>W ${stats.wins}</span><span>L ${stats.losses}</span><span>S ${stats.skipped}</span><span>${stats.winRate}%</span></div>`
  ).join('');
  $('profileStats').innerHTML = profileRows || '<div class="small-muted">Official tracker stats start with version 10 locked calls.</div>';
  renderLadderStats();
  renderLiveReturnTracker();
}

function exportTracker() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, officialTrackerRecords: getOfficialTrackerRecords(), completedLadders: state.ladders, ladderAccuracy: summarizeLadderAccuracy(), currentLadder: state.currentLadder, learning: getLearningSummary(), entryMinuteStats: summarizeEntryMinuteTracker(), liveReturnStats: summarizeLiveReturns() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `edge15-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearTracker() {
  const confirmed = confirm('Clear all tracker records on this browser?');
  if (!confirmed) return;
  state.records = [];
  state.ladders = [];
  state.currentLadder = null;
  saveRecords();
  saveLadders();
  localStorage.removeItem(CURRENT_LADDER_KEY);
  renderCompletedLadders();
  renderRecords();
  renderStats();
}

function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}

function saveRecords() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.records));
}

function loadLadders() {
  try { return JSON.parse(localStorage.getItem(LADDERS_KEY) || '[]'); }
  catch { return []; }
}

function saveLadders() {
  localStorage.setItem(LADDERS_KEY, JSON.stringify(state.ladders));
}

function loadCurrentLadder() {
  try { return JSON.parse(localStorage.getItem(CURRENT_LADDER_KEY) || 'null'); }
  catch { return null; }
}

function saveCurrentLadder() {
  if (state.currentLadder) localStorage.setItem(CURRENT_LADDER_KEY, JSON.stringify(state.currentLadder));
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function saveSettingsFromUi() {
  const tickerEl = $('marketTicker');
  state.settings = {
    targetPrice: $('targetPrice').value,
    minutesLeft: $('minutesLeft').value,
    profile: $('profileSelect').value,
    refreshSeconds: $('refreshSeconds').value,
    marketTicker: tickerEl?.value || '',
    manualEndAt: state.manualEndAt
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}


function setTargetFromCurrent() {
  const latest = state.ticks.at(-1);
  if (!latest) {
    $('readiness').textContent = 'Waiting for Coinbase price before setting target.';
    return;
  }
  $('targetPrice').value = String(Math.round(latest.price));
  resetDecisionSession(false);
  saveSettingsFromUi();
  evaluateAndRender();
}

function startManualCountdown(minutes = 15) {
  state.market = null;
  state.manualEndAt = Date.now() + minutes * 60000;
  $('minutesLeft').value = String(minutes);
  resetDecisionSession(false);
  saveSettingsFromUi();
  evaluateAndRender();
}

function resetDecisionSession(render = true) {
  state.previousRemainingSec = null;
  state.capturedCheckpoints = {};
  state.capturedEntryMinutes = {};
  state.checkpointHistory = [];
  state.signalHistory = [];
  state.heldDecision = null;
  state.pendingSwitch = null;
  state.currentLadder = null;
  localStorage.removeItem(CURRENT_LADDER_KEY);
  if (render) {
    evaluateAndRender(false);
    renderLadder();
  }
}

async function checkApiHealth() {
  const debug = $('apiDebug');
  if (!debug) return;
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    debug.textContent = response.ok && data.ok ? 'API health: connected.' : 'API health: unexpected response.';
  } catch (error) {
    debug.textContent = `API health: ${error.message}`;
  }
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { return null; }
}

function displayCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n > 1 ? n : n * 100).toFixed(1)}¢`;
}

function formatSignedChange(value, suffix = '') {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return '';
  const sign = n > 0 ? '+' : '';
  return ` (${sign}${n.toFixed(1)}${suffix})`;
}

function normalizeDollarPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0000';
  return (n > 1 ? n / 100 : n).toFixed(4);
}

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}
