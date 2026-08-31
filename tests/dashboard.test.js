const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function internals() {
  const window = { addEventListener() {} };
  const document = { querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = {
    window,
    document,
    setTimeout,
    clearTimeout,
    Intl,
    Date,
    Number,
    String,
    Boolean,
    Math,
    Map,
    Set,
    JSON,
    escapeHtml: value => String(value ?? ''),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'dashboard.js' });
  return window.BrasfelsDashboardInternals;
}

const dashboard = internals();

test('normaliza spool keys e interpreta diâmetros reais', () => {
  assert.equal(dashboard.normalizeSpoolKey('CANC-M02_001'), 'M02-001');
  assert.equal(dashboard.normalizeSpoolKey('M02 001'), 'M02001');
  assert.equal(dashboard.parseDiameterInches('2'), 2);
  assert.equal(dashboard.parseDiameterInches('2,5'), 2.5);
  assert.equal(dashboard.parseDiameterInches('1/2'), 0.5);
  assert.equal(dashboard.parseDiameterInches('1 1/2'), 1.5);
  assert.equal(dashboard.parseDiameterInches('1-1/2'), 1.5);
});

test('mantém a regra WEEKNUM(data,14)-1', () => {
  assert.equal(dashboard.legacyWeekNumber('2026-01-01'), 0);
  assert.equal(dashboard.legacyWeekNumber('2026-01-07'), 0);
  assert.equal(dashboard.legacyWeekNumber('2026-01-08'), 1);
  assert.equal(dashboard.legacyWeekNumber('2026-01-15'), 2);
});

test('define spool fabricado somente com todas as juntas PIPE aprovadas', () => {
  const rows = [
    { placement: 'PIPE', dimensional_status: 'A', dimensional_date: '2026-08-10' },
    { placement: 'PIPE', dimensional_status: 'APPROVED', dimensional_date: '2026-08-12' },
    { placement: 'CAMPO', dimensional_status: '', dimensional_date: '' },
  ];
  const state = dashboard.fabricationState(rows);
  assert.equal(state.pipeCount, 2);
  assert.equal(state.pending, 0);
  assert.equal(state.fabricated, true);
  assert.equal(state.completedAt.toISOString().slice(0, 10), '2026-08-12');
});

test('rateia peso por junta sem double-count', () => {
  assert.equal(dashboard.proportionalWeight(100, 4), 25);
  assert.equal(dashboard.proportionalWeight(100, 0), 0);
  const normal = dashboard.backlogState(100, 4, 1, false);
  const hold = dashboard.backlogState(100, 4, 1, true);
  assert.equal(normal.pendingWeight, 25);
  assert.equal(normal.holdWeight, 0);
  assert.equal(normal.normalWeight, 25);
  assert.equal(hold.pendingWeight, 25);
  assert.equal(hold.holdWeight, 25);
  assert.equal(hold.normalWeight, 0);
});

test('calcula rundown real e planejado separadamente', () => {
  const result = dashboard.rundownSeries(1, [
    { key: '2026-1', actual: 0.2, planned: 0.4 },
    { key: '2026-2', actual: 0.3, planned: 0.1 },
  ]);
  assert.equal(result[0].actualRemaining, 0.8);
  assert.equal(result[0].plannedRemaining, 0.6);
  assert.equal(result[1].actualRemaining, 0.5);
  assert.equal(result[1].plannedRemaining, 0.5);
});

test('remove duplicidade spool+junta antes das métricas', () => {
  const rows = [
    { spool_key: 'M02-001', joint: 'J01' },
    { spool_key: 'M02_001', joint: 'J01' },
    { spool_key: 'M02-001', joint: 'J02' },
  ];
  assert.equal(dashboard.uniqueJointRows(rows).length, 2);
});
