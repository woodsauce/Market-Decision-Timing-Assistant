import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKPOINT_MINUTES,
  evaluateDecision,
  shouldCaptureCheckpoint,
  createRecord,
  settleRecord,
  summarizeRecords
} from '../lib/decision-engine.mjs';

function ticks(start = 100000, step = 12, count = 80) {
  const base = Date.now() - count * 3000;
  return Array.from({ length: count }, (_, i) => ({
    price: start + i * step + Math.sin(i / 3) * 4,
    ts: base + i * 3000,
    volume: 1
  }));
}

test('checkpoint constants are the requested decision ladder', () => {
  assert.deepEqual(CHECKPOINT_MINUTES, [12, 10, 8, 6, 4, 2]);
});

test('captures a checkpoint when crossing the threshold', () => {
  const captured = {};
  assert.equal(shouldCaptureCheckpoint(undefined, 719, captured), null);
  assert.equal(shouldCaptureCheckpoint(721, 719, captured), 12);
  captured['12'] = true;
  assert.equal(shouldCaptureCheckpoint(720, 710, captured), null);
});

test('rising market above target produces OVER or valid skip with reasons', () => {
  const decision = evaluateDecision({
    ticks: ticks(100000, 16, 100),
    targetPrice: 100600,
    timeRemainingSec: 330,
    profile: 'balanced',
    recentDecisions: [
      { choice: 'OVER', confidence: 68 },
      { choice: 'OVER', confidence: 71 }
    ]
  });
  assert.ok(['OVER', 'SKIP'].includes(decision.action));
  assert.equal(decision.choice, 'OVER');
  assert.ok(decision.confidence >= 1);
  assert.ok(decision.reasons.length >= 3);
});

test('falling market below target favors UNDER', () => {
  const decision = evaluateDecision({
    ticks: ticks(100000, -15, 100),
    targetPrice: 99400,
    timeRemainingSec: 330,
    profile: 'balanced',
    recentDecisions: [
      { choice: 'UNDER', confidence: 68 },
      { choice: 'UNDER', confidence: 71 }
    ]
  });
  assert.equal(decision.choice, 'UNDER');
  assert.ok(['UNDER', 'SKIP'].includes(decision.action));
});

test('records summarize wins/losses/skips', () => {
  const decision = evaluateDecision({
    ticks: ticks(),
    targetPrice: 100500,
    timeRemainingSec: 330,
    profile: 'balanced',
    recentDecisions: [{ choice: 'OVER', confidence: 80 }]
  });
  const base = createRecord({ decision, market: { ticker: 'TEST' } });
  const records = [
    settleRecord(base, 'win', 101000),
    settleRecord({ ...base, id: 'second' }, 'loss', 99000),
    settleRecord({ ...base, id: 'third', recommendation: 'SKIP' }, 'skipped')
  ];
  const summary = summarizeRecords(records);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.winRate, 50);
});
