/**
 * Tests for password generation.
 */

import { describe, it, expect } from 'vitest';
import { generatePassword, checkPasswordStrength } from '../src/password.js';

describe('generatePassword', () => {
  it('should generate password with default length', () => {
    const password = generatePassword();
    expect(password.length).toBe(24);
  });

  it('should generate password with custom length', () => {
    const password = generatePassword({ length: 16 });
    expect(password.length).toBe(16);
  });

  it('should generate password with symbols', () => {
    let hasSymbol = false;
    for (let i = 0; i < 10; i++) {
      const password = generatePassword({ length: 24, symbols: true });
      if (/[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]/.test(password)) {
        hasSymbol = true;
        break;
      }
    }
    expect(hasSymbol).toBe(true);
  });

  it('should generate password without symbols', () => {
    const password = generatePassword({ length: 24, noSymbols: true });
    expect(/[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]/.test(password)).toBe(false);
  });

  it('should generate XKCD-style password', () => {
    const password = generatePassword({ xkcd: true });
    const parts = password.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate XKCD-style password with custom separator', () => {
    const password = generatePassword({ xkcd: true, xkcdSeparator: '_' });
    expect(password).toContain('_');
  });

  it('should generate random passwords', () => {
    const passwords = Array.from({ length: 5 }, () => generatePassword());
    const uniquePasswords = new Set(passwords);
    expect(uniquePasswords.size).toBe(5);
  });

  it('should contain required character types', () => {
    const password = generatePassword({ length: 12, symbols: true });
    
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    
    expect(hasLower).toBe(true);
    expect(hasUpper).toBe(true);
    expect(hasDigit).toBe(true);
  });
});

describe('checkPasswordStrength', () => {
  it('should detect weak password', () => {
    const strength = checkPasswordStrength('abc');
    expect(strength.strength).toBe('weak');
    expect(strength.length).toBe(3);
  });

  it('should detect fair password', () => {
    const strength = checkPasswordStrength('Password1');
    expect(['fair', 'good']).toContain(strength.strength);
  });

  it('should detect strong password', () => {
    const strength = checkPasswordStrength('MyV3ryStr0ng!P@ssw0rd#2024');
    expect(strength.strength).toBe('strong');
  });

  it('should contain all flags', () => {
    const strength = checkPasswordStrength('Test123!');
    
    expect(strength).toHaveProperty('hasLowercase');
    expect(strength).toHaveProperty('hasUppercase');
    expect(strength).toHaveProperty('hasDigits');
    expect(strength).toHaveProperty('hasSymbols');
    expect(strength).toHaveProperty('entropy');
    expect(strength).toHaveProperty('length');
  });

  it('should have accurate flags', () => {
    const strength = checkPasswordStrength('Password123!');
    
    expect(strength.hasLowercase).toBe(true);
    expect(strength.hasUppercase).toBe(true);
    expect(strength.hasDigits).toBe(true);
    expect(strength.hasSymbols).toBe(true);
  });
});
