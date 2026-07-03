import {
  CHECKPOINT_MINUTES,
  PROFILES,
  evaluateDecision,
  createRecord,
  settleRecord,
  summarizeRecords,
  shouldCaptureCheckpoint
} from './lib/decision-engine.mjs';

const STORE_KEY = 'edge15.records.v1';
const SETTINGS_KEY = 'edge15.settings.v1';
const LADDERS_KEY = 'edge15.ladders.v1';
const CURRENT_LADDER_KEY = 'edge15.currentLadder.v1';
const MAX_TICKS = 900;
const BASE_HOLD_MS = 60_000;
const STRONG_HOLD_MS = 90_000;
const SWITCH_CONFIRM_MS = 14_000;

const state = {
  ticks: [],
  records: loadRecords(),
  ladders: loadLadders(),
  currentLadder: loadCurrentLadder(),
  settings: loadSettings(),
  decision: null,
  previousRemainingSec: null,
  capturedCheckpoints: {},
  checkpointHistory: [],
  market: null,
  orderbook: null,
  coinbasePrediction: null,
  localPrediction: null,
  signalHistory: [],
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
  $('kalshiSearch').value = state.settings.kalshiSearch || 'bitcoin';
  $('contractCount').value = state.settings.contractCount || '1.00';
  $('maxPrice').value = state.settings.maxPrice || '0.7600';
  $('marketTicker').value = state.settings.marketTicker || '';
}


function renderProfiles() {
  const select = $('profileSelect');
  select.innerHTML = Object.entries(PROFILES).map(([key, profile]) =>
    `<option value="${key}">${profile.label}</option>`
  ).join('');
  select.value = state.settings.profile || 'balanced';
}

function wireEvents() {
  ['targetPrice', 'profileSelect', 'refreshSeconds', 'kalshiSearch', 'contractCount', 'maxPrice', 'marketTicker'].forEach((id) => {
    $(id).addEventListener('input', () => {
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
  $('paperTrade').addEventListener('click', () => recordCurrentDecision('paper'));
  $('skipTrade').addEventListener('click', () => recordCurrentDecision('skip'));
  const refreshPrediction = $('refreshPrediction');
  if (refreshPrediction) refreshPrediction.addEventListener('click', () => loadCoinbasePrediction(false));
  $('loadMarkets').addEventListener('click', loadKalshiMarkets);
  $('loadOrderbook').addEventListener('click', loadOrderbook);
  $('previewOrder').addEventListener('click', previewOrder);
  $('liveOrder').addEventListener('click', placeLiveOrder);
  $('armLive').addEventListener('change', updateLiveOrderButton);
  $('liveConfirmText').addEventListener('input', updateLiveOrderButton);
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
      return { price, ts, volume: Number(item.volume || item.size || 0), source: 'coinbase' };
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
  const previousKey = [state.market?.ticker, $('targetPrice').value, state.market?.close_time].join('|');
  const nextKey = [data.ticker, data.targetPrice, data.closeTime].join('|');

  state.market = {
    source: data.source || 'coinbase_predictions',
    ticker: data.ticker || 'COINBASE-BTC-15M',
    title: data.title,
    close_time: data.closeTime,
    yes_bid: data.yesPrice,
    no_bid: data.noPrice,
    indicativeOnly: data.source === 'coinbase_predictions' || data.source === 'local_coinbase_15m_window'
  };

  state.orderbook = {
    yesPrice: data.yesPrice,
    noPrice: data.noPrice,
    source: data.source || 'coinbase_predictions',
    indicativeOnly: data.source === 'coinbase_predictions' || data.source === 'local_coinbase_15m_window',
    raw: data
  };

  $('targetPrice').value = String(data.targetPrice);
  if (data.ticker) $('marketTicker').value = data.ticker;
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
  const rawDecision = evaluateDecision({
    ticks: state.ticks,
    targetPrice,
    timeRemainingSec: remainingSec,
    profile,
    market: state.orderbook || state.market || {},
    recentDecisions: [...state.signalHistory, ...state.checkpointHistory]
  });
  rememberSignal(rawDecision);
  const decision = stabilizeDecision(rawDecision);
  state.decision = decision;

  ensureCurrentLadder();
  updateCurrentLadderDecision(decision);

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
  const holdMs = remainingSec <= 360 ? STRONG_HOLD_MS : BASE_HOLD_MS;

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
    const immediateOverride = Number(decision.confidence || 0) >= 86 && Number(decision.flipRisk || 100) <= 28 && confidenceLead >= 10;
    const confirmedSwitch = pendingForMs >= SWITCH_CONFIRM_MS && confidenceLead >= 8 && flipImprovement >= 3;

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
  $('stability').textContent = fmtPct(decision.stability);
  $('flipRisk').textContent = fmtPct(decision.flipRisk);
  $('checkpoint').textContent = `${decision.checkpoint || '—'}m`;
  $('fairPrice').textContent = decision.marketValue?.price ? `${decision.marketValue.price}¢` : '—';
}

function renderMarketBasics() {
  const latest = state.ticks.at(-1);
  $('btcPrice').textContent = latest ? fmtMoney(latest.price) : '—';
  $('targetDisplay').textContent = Number($('targetPrice').value) ? fmtMoney(Number($('targetPrice').value)) : '—';
  $('timeLeftDisplay').textContent = formatRemaining(getRemainingSec());
  const yes = state.orderbook?.yesPrice ?? state.coinbasePrediction?.yesPrice ?? state.market?.yes_bid ?? state.market?.yes_ask ?? state.market?.last_price;
  const no = state.orderbook?.noPrice ?? state.coinbasePrediction?.noPrice ?? state.market?.no_bid ?? state.market?.no_ask;
  $('yesPrice').textContent = yes ? displayCents(yes) : '—';
  $('noPrice').textContent = no ? displayCents(no) : '—';
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
    lastCall: null,
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

function finalizeCurrentLadder(reason = 'closed') {
  const ladder = state.currentLadder;
  if (!ladder || ladder.settledAt) return null;
  const close = Date.parse(ladder.closeTime);
  if (Number.isFinite(close) && close - Date.now() > 2500 && reason !== 'window_changed' && reason !== 'new_window') return null;

  const finalPrice = state.ticks.at(-1)?.price ?? ladder.lastSeenPrice;
  const targetPrice = Number(ladder.targetPrice);
  if (!Number.isFinite(finalPrice) || !Number.isFinite(targetPrice)) return null;

  const finalSide = finalPrice > targetPrice ? 'OVER' : finalPrice < targetPrice ? 'UNDER' : 'PUSH';
  const lastCheckpointCall = CHECKPOINT_MINUTES
    .map((minutes) => ({ minutes, decision: ladder.checkpoints[String(minutes)] }))
    .filter((item) => item.decision && ['OVER', 'UNDER'].includes(item.decision.action))
    .at(-1);
  const recommendation = ladder.lastCall?.action || lastCheckpointCall?.decision?.action || 'SKIP';
  const result = finalSide === 'PUSH' ? 'void' : recommendation === 'SKIP' ? 'skipped' : recommendation === finalSide ? 'win' : 'loss';

  const completed = {
    ...ladder,
    recommendation,
    result,
    finalSide,
    finalPrice: Number(finalPrice),
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
  const call = ladder.lastCall || {};
  const record = {
    id: `${ladder.id}-auto`,
    ts: ladder.settledAt || Date.now(),
    recordType: 'auto_ladder',
    windowKey: ladder.windowKey,
    ticker: ladder.ticker,
    title: ladder.title,
    targetPrice: ladder.targetPrice,
    currentPrice: call.currentPrice || null,
    checkpoint: call.checkpoint || 'ladder',
    profileKey: ladder.profileKey,
    profile: ladder.profile,
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
    checkpoints: ladder.checkpoints || {}
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
    return;
  }
  container.innerHTML = state.ladders.slice(0, 5).map((ladder) => {
    const checkpoints = CHECKPOINT_MINUTES.map((minutes) => {
      const cp = ladder.checkpoints?.[String(minutes)];
      const label = cp?.action || '—';
      const cls = label.toLowerCase();
      return `<div class="history-cp ${cls}"><span>${minutes}m</span><strong>${escapeHtml(label)}</strong></div>`;
    }).join('');
    const resultClass = ladder.result === 'win' ? 'good' : ladder.result === 'loss' ? 'bad' : 'warn';
    return `<div class="ladder-record">\n      <div class="ladder-record-head">\n        <div>\n          <strong>${escapeHtml(ladder.recommendation || 'SKIP')} call · ${escapeHtml((ladder.result || 'open').toUpperCase())}</strong>\n          <span class="small-muted">${new Date(ladder.settledAt || ladder.startedAt).toLocaleString()} · Target ${fmtMoney(ladder.targetPrice)} · Final ${fmtMoney(ladder.finalPrice)}</span>\n        </div>\n        <div class="final-badge ${resultClass}">Ended ${escapeHtml(ladder.finalSide || '—')}</div>\n      </div>\n      <div class="history-ladder">${checkpoints}</div>\n    </div>`;
  }).join('');
}

function drawSparkline() {
  const canvas = $('sparkline');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070a10';
  ctx.fillRect(0, 0, width, height);
  const ticks = state.ticks.slice(-180);
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

async function loadKalshiMarkets() {
  const search = $('kalshiSearch').value || 'bitcoin 15';
  saveSettingsFromUi();
  $('kalshiStatus').textContent = 'Kalshi: loading';
  $('kalshiStatus').className = 'pill warn';
  $('marketsList').innerHTML = '<div class="small-muted">Loading open markets…</div>';
  try {
    const response = await fetch(`/api/kalshi/markets?status=open&limit=200&search=${encodeURIComponent(search)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Kalshi request failed');
    $('kalshiStatus').textContent = `Kalshi: ${data.count} found`;
    $('kalshiStatus').className = data.count ? 'pill good' : 'pill warn';
    renderMarketList(data.markets || []);
  } catch (error) {
    $('kalshiStatus').textContent = 'Kalshi: error';
    $('kalshiStatus').className = 'pill bad';
    $('marketsList').innerHTML = `<div class="small-muted">${escapeHtml(error.message)}. If this says 404, update to the fixed ZIP because the Kalshi API routes were missing.</div>`;
  }
}

function renderMarketList(markets) {
  if (!markets.length) {
    $('marketsList').innerHTML = '<div class="small-muted">No matching open markets. Try search terms like “BTC 15”, “crypto 15”, or paste a ticker directly.</div>';
    return;
  }
  $('marketsList').innerHTML = markets.slice(0, 25).map((market, index) => {
    const ticker = market.ticker || market.market_ticker || '';
    const title = market.title || market.subtitle || ticker;
    const meta = [ticker, market.close_time, market.status].filter(Boolean).join(' · ');
    return `<div class="market-row">
      <div><strong>${escapeHtml(title)}</strong><span class="small-muted">${escapeHtml(meta)}</span></div>
      <button data-market-index="${index}">Select</button>
    </div>`;
  }).join('');
  [...$('marketsList').querySelectorAll('button[data-market-index]')].forEach((button) => {
    button.addEventListener('click', () => {
      const market = markets[Number(button.dataset.marketIndex)];
      selectMarket(market);
    });
  });
}

function selectMarket(market) {
  state.market = market;
  resetDecisionSession(false);
  const ticker = market.ticker || market.market_ticker || '';
  $('marketTicker').value = ticker;
  const target = inferTargetPrice(market);
  if (target) $('targetPrice').value = String(target);
  saveSettingsFromUi();
  renderMarketBasics();
  evaluateAndRender();
  loadOrderbook();
}

function inferTargetPrice(market) {
  const text = [market.title, market.subtitle, market.rules_primary, market.rules_secondary].filter(Boolean).join(' ');
  const matches = [...text.matchAll(/\$?([0-9]{2,3}(?:,[0-9]{3})+(?:\.\d+)?|[0-9]{5,6}(?:\.\d+)?)/g)]
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((value) => value > 1000 && value < 1000000);
  return matches[0] || null;
}

async function loadOrderbook() {
  const ticker = $('marketTicker').value.trim();
  if (!ticker) return;
  saveSettingsFromUi();
  try {
    const response = await fetch(`/api/kalshi/orderbook?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Orderbook request failed');
    const normalized = data.orderbook?.yesPrice !== undefined ? data.orderbook : normalizeOrderbook(data.orderbook || data);
    state.orderbook = { ...normalized, ticker };
    $('kalshiStatus').textContent = 'Kalshi: orderbook';
    $('kalshiStatus').className = 'pill good';
    renderMarketBasics();
    evaluateAndRender();
  } catch (error) {
    $('kalshiStatus').textContent = 'Kalshi: orderbook error';
    $('kalshiStatus').className = 'pill bad';
    $('orderPreview').textContent = error.message;
  }
}

function normalizeOrderbook(orderbook) {
  const yes = Array.isArray(orderbook.yes) ? orderbook.yes : [];
  const no = Array.isArray(orderbook.no) ? orderbook.no : [];
  const bestYes = yes.length ? Math.max(...yes.map((row) => Number(Array.isArray(row) ? row[0] : row.price)).filter(Number.isFinite)) : null;
  const bestNo = no.length ? Math.max(...no.map((row) => Number(Array.isArray(row) ? row[0] : row.price)).filter(Number.isFinite)) : null;
  return {
    yesPrice: bestYes ? (bestYes > 1 ? bestYes : bestYes * 100) : null,
    noPrice: bestNo ? (bestNo > 1 ? bestNo : bestNo * 100) : null,
    raw: orderbook
  };
}

function previewOrder() {
  if (!state.decision) evaluateAndRender();
  const order = buildOrderPayload();
  $('orderPreview').textContent = JSON.stringify(order, null, 2);
}

function buildOrderPayload() {
  const ticker = $('marketTicker').value.trim();
  const action = state.decision?.action;
  const count = $('contractCount').value || '1.00';
  const maxPrice = $('maxPrice').value || '0.7600';
  let side = 'bid';
  let intended = action;
  let note = 'Kalshi orders are quoted from the YES side. Buying DOWN/NO may require selling YES or using the equivalent NO flow in Kalshi UI.';
  if (action === 'UNDER') {
    side = 'ask';
    intended = 'UNDER / economic NO';
  }
  return {
    mode: 'preview_only',
    intended,
    ticker,
    side,
    count,
    price: normalizeDollarPrice(maxPrice),
    time_in_force: 'immediate_or_cancel',
    assistant: {
      action,
      confidence: state.decision?.confidence,
      flipRisk: state.decision?.flipRisk,
      stability: state.decision?.stability
    },
    note
  };
}

function updateLiveOrderButton() {
  const armed = $('armLive').checked && $('liveConfirmText').value.trim() === 'LIVE';
  $('liveOrder').disabled = !armed;
  $('tradeMode').textContent = armed ? 'Live armed' : 'Paper';
}

async function placeLiveOrder() {
  const payload = buildOrderPayload();
  if (!$('armLive').checked || $('liveConfirmText').value.trim() !== 'LIVE') {
    $('orderPreview').textContent = 'Live order blocked locally. Check Arm and type LIVE first.';
    return;
  }
  if (!confirm('This can place a real Kalshi order if server keys are enabled. Continue?')) return;
  try {
    const response = await fetch('/api/kalshi/order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-edge15-live-confirm': 'I_UNDERSTAND_REAL_MONEY_RISK'
      },
      body: JSON.stringify({
        ticker: payload.ticker,
        side: payload.side,
        count: payload.count,
        price: payload.price,
        time_in_force: payload.time_in_force
      })
    });
    const data = await response.json();
    $('orderPreview').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    $('orderPreview').textContent = error.message;
  }
}

function recordCurrentDecision(mode = 'decision') {
  if (!state.decision) evaluateAndRender();
  const decision = mode === 'skip' ? { ...state.decision, action: 'SKIP' } : state.decision;
  const record = createRecord({ decision, market: state.market || { ticker: $('marketTicker').value }, userEntry: mode === 'paper' ? `paper:${decision.action}` : decision.action });
  record.checkpoints = { ...state.capturedCheckpoints };
  state.records.unshift(record);
  saveRecords();
  renderRecords();
  renderStats();
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
    node.querySelector('.record-title').textContent = `${record.recommendation} · ${confidenceLabel} · ${record.result}${finalLabel}`;
    node.querySelector('.record-meta').textContent = `${new Date(record.ts).toLocaleString()} · ${typeLabel} · ${record.profile} · ${record.checkpoint} · ${record.ticker || 'manual'}`;
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

function renderStats() {
  const summary = summarizeRecords(state.records);
  $('wins').textContent = summary.wins;
  $('losses').textContent = summary.losses;
  $('skipped').textContent = summary.skipped;
  $('winRate').textContent = `${summary.winRate}%`;
  const profileRows = Object.entries(summary.byProfile).map(([profile, stats]) =>
    `<div class="mini-row"><strong>${escapeHtml(profile)}</strong><span>W ${stats.wins}</span><span>L ${stats.losses}</span><span>S ${stats.skipped}</span><span>${stats.winRate}%</span></div>`
  ).join('');
  $('profileStats').innerHTML = profileRows || '<div class="small-muted">Profile stats appear after records are added.</div>';
}

function exportTracker() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, completedLadders: state.ladders, currentLadder: state.currentLadder }, null, 2)], { type: 'application/json' });
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
  state.settings = {
    targetPrice: $('targetPrice').value,
    minutesLeft: $('minutesLeft').value,
    profile: $('profileSelect').value,
    refreshSeconds: $('refreshSeconds').value,
    kalshiSearch: $('kalshiSearch').value,
    contractCount: $('contractCount').value,
    maxPrice: $('maxPrice').value,
    marketTicker: $('marketTicker').value,
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
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (response.ok && data.ok) {
      $('apiDebug').textContent = 'API health: connected.';
      return;
    }
    $('apiDebug').textContent = 'API health: unexpected response.';
  } catch (error) {
    $('apiDebug').textContent = `API health: ${error.message}`;
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
