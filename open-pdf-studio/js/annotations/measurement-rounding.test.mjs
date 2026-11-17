import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../core/app-test-hooks.mjs');
installeerBrowserStubs();
const { state } = await import('../core/state.js');
const { formatMeasurement } = await import('./measurement.js');
const { roundingStepIn, roundToPreferenceStep } = await import('./measure-precision.js');

function show(value, unit, rounding, extra = {}) {
  state.preferences.measureRounding = rounding;
  state.preferences.measureDisplayUnit = 'auto';
  state.preferences.measureDualUnits = false;
  try {
    return formatMeasurement({ value, unit, calibrated: true, ...extra });
  } finally {
    state.preferences.measureRounding = 'none';
  }
}

test('the millimetre step is converted to the unit of the measurement', () => {
  assert.deepEqual(roundingStepIn('10', 'm'), { step: 0.01, decimals: 2 });
  assert.deepEqual(roundingStepIn('5', 'm'), { step: 0.005, decimals: 3 });
  assert.deepEqual(roundingStepIn('10', 'cm'), { step: 1, decimals: 0 });
  assert.equal(roundingStepIn('10', 'm²'), null);
  assert.equal(roundingStepIn('10', 'ft³'), null);
  assert.equal(roundingStepIn('10', 'pt'), null);
  assert.equal(roundingStepIn('none', 'mm'), null);
  assert.equal(roundToPreferenceStep(12.344, 'm', '10'), 12.34);
  assert.equal(roundToPreferenceStep(1234, 'mm', '5'), 1235);
});

test('10 mm rounding keeps a metre length at centimetres, not tens of metres', () => {
  assert.equal(show(12.344, 'm', '10'), '12.34 m');
  assert.equal(show(12.3466, 'm', '5'), '12.345 m');
  assert.equal(show(1234, 'mm', '10'), '1230 mm');
  assert.equal(show(123.44, 'cm', '10'), '123 cm');
});

test('feet-inches readings round to the millimetre step, not to 10 ft', () => {
  // 23.88 ft = 7278.6 mm; the nearest 10 mm is 7280 mm, about 23'-10 5/8"
  assert.equal(show(23.88, 'ft', '10'), `23'-10 5/8"`);
  assert.equal(show(23.88, 'ft', 'none'), `23'-10 9/16"`);
});

test('areas and volumes are not rounded by the length step', () => {
  assert.equal(show(12.3456, 'm²', '10'), '12.35 m²');
  assert.equal(show(23.4567, 'ft²', '10'), '23.46 ft²');
});
