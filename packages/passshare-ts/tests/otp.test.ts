/**
 * Tests for OTP functionality.
 */

import { describe, it, expect } from 'vitest';
import { TOTP, HOTP, parseOtpUri, generateOtpUri } from '../src/otp.js';

describe('TOTP', () => {
  const TEST_SECRET = 'JBSWY3DPEHPK3PXP';

  it('should generate code', () => {
    const totp = new TOTP(TEST_SECRET);
    const code = totp.generate();
    
    expect(code.length).toBe(6);
    expect(/^\d+$/.test(code)).toBe(true);
  });

  it('should generate code for specific timestamp', () => {
    const totp = new TOTP(TEST_SECRET);
    const code = totp.generate(59);
    expect(code.length).toBe(6);
  });

  it('should verify code', () => {
    const totp = new TOTP(TEST_SECRET);
    const currentCode = totp.generate();
    
    expect(totp.verify(currentCode)).toBe(true);
    expect(totp.verify('000000')).toBe(false);
  });

  it('should verify with window', () => {
    const totp = new TOTP(TEST_SECRET, 6, 30);
    const pastCode = totp.generate(Math.floor(Date.now() / 1000) - 30);
    
    expect(totp.verify(pastCode, 1)).toBe(true);
  });

  it('should support custom digits', () => {
    const totp = new TOTP(TEST_SECRET, 8);
    const code = totp.generate();
    
    expect(code.length).toBe(8);
  });

  it('should calculate remaining seconds', () => {
    const totp = new TOTP(TEST_SECRET, 6, 30);
    const remaining = totp.remainingSeconds;
    
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(30);
  });
});

describe('HOTP', () => {
  const TEST_SECRET = 'JBSWY3DPEHPK3PXP';

  it('should generate code', () => {
    const hotp = new HOTP(TEST_SECRET, 6, 0);
    const code = hotp.generate();
    
    expect(code.length).toBe(6);
    expect(/^\d+$/.test(code)).toBe(true);
  });

  it('should not increment counter on generate', () => {
    const hotp = new HOTP(TEST_SECRET, 6, 0);
    const code1 = hotp.generate();
    const code2 = hotp.generate();
    
    expect(code1).toBe(code2);
  });

  it('should increment counter on verify', () => {
    const hotp = new HOTP(TEST_SECRET, 6, 0);
    const code = hotp.generate();
    
    expect(hotp.verify(code)).toBe(true);
    expect(hotp.counter).toBe(1);
  });

  it('should verify with window', () => {
    const hotp = new HOTP(TEST_SECRET, 6, 0);
    const tempHotp = new HOTP(TEST_SECRET, 6, 5);
    const futureCode = tempHotp.generate();
    
    expect(hotp.verify(futureCode, 10)).toBe(true);
    expect(hotp.counter).toBe(6);
  });
});

describe('parseOtpUri', () => {
  it('should parse TOTP URI', () => {
    const uri = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';
    const otp = parseOtpUri(uri);
    
    expect(otp).toBeInstanceOf(TOTP);
    expect(otp.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(otp.digits).toBe(6);
  });

  it('should parse HOTP URI', () => {
    const uri = 'otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=0';
    const otp = parseOtpUri(uri);
    
    expect(otp).toBeInstanceOf(HOTP);
    expect(otp.secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('should parse with custom params', () => {
    const uri = 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256';
    const otp = parseOtpUri(uri) as TOTP;
    
    expect(otp.digits).toBe(8);
    expect(otp.period).toBe(60);
    expect(otp.algorithm).toBe('SHA256');
  });

  it('should throw on invalid scheme', () => {
    expect(() => parseOtpUri('http://example.com')).toThrow();
  });

  it('should throw on missing secret', () => {
    expect(() => parseOtpUri('otpauth://totp/Test')).toThrow();
  });
});

describe('generateOtpUri', () => {
  it('should generate TOTP URI', () => {
    const uri = generateOtpUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Example',
      account: 'alice@example.com',
    });
    
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Example');
  });

  it('should generate HOTP URI', () => {
    const uri = generateOtpUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Example',
      account: 'alice',
      type: 'hotp',
      counter: 5,
    });
    
    expect(uri).toContain('otpauth://hotp/');
    expect(uri).toContain('counter=5');
  });

  it('should roundtrip', () => {
    const originalUri = generateOtpUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Test',
      account: 'user',
      digits: 8,
      period: 60,
    });
    
    const parsed = parseOtpUri(originalUri) as TOTP;
    
    expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.digits).toBe(8);
    expect(parsed.period).toBe(60);
  });
});
