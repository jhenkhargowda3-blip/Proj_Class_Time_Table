import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { evaluatePasswordStrength } from '../public/js/passwordStrength.js';

test('Batch 3: Security & UI (Password Strength Meter for Login & Reset Forms)', async (t) => {
  await t.test('1. Empty or undefined password evaluation', () => {
    const emptyResult = evaluatePasswordStrength('');
    assert.strictEqual(emptyResult.bars, 0);
    assert.strictEqual(emptyResult.level, 'none');

    const nullResult = evaluatePasswordStrength(null);
    assert.strictEqual(nullResult.bars, 0);
  });

  await t.test('2. Weak password classification (< 6 chars or trivial)', () => {
    const res1 = evaluatePasswordStrength('12345');
    assert.strictEqual(res1.level, 'weak');
    assert.strictEqual(res1.bars, 1);
    assert.strictEqual(res1.color, '#ef4444');

    const res2 = evaluatePasswordStrength('admin');
    assert.strictEqual(res2.level, 'weak');
    assert.strictEqual(res2.bars, 1);
  });

  await t.test('3. Fair/Moderate password classification (6-8 chars with limited variety)', () => {
    const res = evaluatePasswordStrength('password12');
    assert.strictEqual(res.level, 'fair');
    assert.strictEqual(res.bars, 2);
    assert.strictEqual(res.color, '#f59e0b');
  });

  await t.test('4. Strong password classification (8+ chars with uppercase, digits, symbols)', () => {
    const res = evaluatePasswordStrength('AdminPass!23');
    assert.ok(res.bars >= 3, 'Should have at least 3 bars');
    assert.ok(res.level === 'good' || res.level === 'strong');
  });

  await t.test('5. Very Strong password classification (12+ chars with full variety)', () => {
    const res = evaluatePasswordStrength('Campus@Scheduler#2026!');
    assert.strictEqual(res.level, 'strong');
    assert.strictEqual(res.bars, 4);
    assert.strictEqual(res.color, '#059669');
  });

  await t.test('6. HTML verification: public/index.html contains password meter elements for login and reset', () => {
    const htmlPath = path.resolve(process.cwd(), 'public/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Login meter elements
    assert.ok(htmlContent.includes('id="login-password-meter-wrap"'), 'Must have login-password-meter-wrap');
    assert.ok(htmlContent.includes('id="login-password-strength-label"'), 'Must have login-password-strength-label');
    assert.ok(htmlContent.includes('id="login-meter-bar-1"'), 'Must have login-meter-bar-1');
    assert.ok(htmlContent.includes('id="login-meter-bar-4"'), 'Must have login-meter-bar-4');

    // Reset meter elements
    assert.ok(htmlContent.includes('id="reset-password-meter-wrap"'), 'Must have reset-password-meter-wrap');
    assert.ok(htmlContent.includes('id="reset-password-strength-label"'), 'Must have reset-password-strength-label');
    assert.ok(htmlContent.includes('id="reset-meter-bar-1"'), 'Must have reset-meter-bar-1');
    assert.ok(htmlContent.includes('id="reset-meter-bar-4"'), 'Must have reset-meter-bar-4');
  });
});
