/**
 * Tests for Secret class.
 */

import { describe, it, expect } from 'vitest';
import { Secret } from '../src/secret.js';

describe('Secret', () => {
  describe('constructor', () => {
    it('should create an empty secret', () => {
      const secret = new Secret();
      expect(secret.password).toBe('');
      expect(secret.keys()).toEqual([]);
      expect(secret.body).toBe('');
    });

    it('should create a secret with password only', () => {
      const secret = new Secret('my-secret-password');
      expect(secret.password).toBe('my-secret-password');
      expect(secret.toString()).toBe('my-secret-password');
    });

    it('should create a secret with data', () => {
      const secret = new Secret('password123', {
        username: 'john',
        url: 'https://example.com',
      });
      expect(secret.password).toBe('password123');
      expect(secret.get('username')).toBe('john');
      expect(secret.get('url')).toBe('https://example.com');
      expect(secret.get('missing', 'default')).toBe('default');
    });

    it('should create a secret with body', () => {
      const secret = new Secret('password123', undefined, 'Additional notes');
      expect(secret.password).toBe('password123');
      expect(secret.body).toBe('Additional notes');
    });
  });

  describe('parse', () => {
    it('should parse simple secret', () => {
      const content = 'my-password';
      const secret = Secret.parse(content);
      expect(secret.password).toBe('my-password');
    });

    it('should parse secret with data', () => {
      const content = `my-password
---
username: john@example.com
url: https://example.com
---`;
      const secret = Secret.parse(content);
      expect(secret.password).toBe('my-password');
      expect(secret.get('username')).toBe('john@example.com');
      expect(secret.get('url')).toBe('https://example.com');
    });

    it('should parse secret with body', () => {
      const content = `my-password
---
username: john
---
Additional notes
Multiple lines`;
      const secret = Secret.parse(content);
      expect(secret.password).toBe('my-password');
      expect(secret.get('username')).toBe('john');
      expect(secret.body).toContain('Additional notes');
      expect(secret.body).toContain('Multiple lines');
    });

    it('should parse OTP URI', () => {
      const content = `my-password
---
otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example
---`;
      const secret = Secret.parse(content);
      expect(secret.otpUri).not.toBeNull();
      expect(secret.otpUri).toContain('otpauth://totp');
    });
  });

  describe('get/set/delete', () => {
    it('should set and get values', () => {
      const secret = new Secret('password');
      secret.set('key1', 'value1');
      expect(secret.get('key1')).toBe('value1');
    });

    it('should delete values', () => {
      const secret = new Secret('password');
      secret.set('key1', 'value1');
      expect(secret.delete('key1')).toBe(true);
      expect(secret.get('key1')).toBe('');
      expect(secret.delete('nonexistent')).toBe(false);
    });
  });

  describe('serialization', () => {
    it('should convert to string', () => {
      const secret = new Secret('password123', { username: 'john' }, 'Notes');
      const output = secret.toString();
      expect(output).toContain('password123');
      expect(output).toContain('username: john');
      expect(output).toContain('Notes');
    });

    it('should convert to/from buffer', () => {
      const original = new Secret('password123', { key: 'value' }, 'Body text');
      const buffer = original.toBuffer();
      const restored = Secret.fromBuffer(buffer);
      
      expect(restored.password).toBe(original.password);
      expect(restored.get('key')).toBe(original.get('key'));
      expect(restored.body).toBe(original.body);
    });
  });

  describe('equality', () => {
    it('should compare equal secrets', () => {
      const secret1 = new Secret('pass', { key: 'value' });
      const secret2 = new Secret('pass', { key: 'value' });
      expect(secret1.equals(secret2)).toBe(true);
    });

    it('should compare different secrets', () => {
      const secret1 = new Secret('pass', { key: 'value' });
      const secret2 = new Secret('different');
      expect(secret1.equals(secret2)).toBe(false);
    });
  });

  describe('data property', () => {
    it('should return a copy of data', () => {
      const secret = new Secret('pass', { key: 'value' });
      const data = secret.data;
      data['new_key'] = 'new_value';
      
      // Original should not be affected
      expect(secret.get('new_key')).toBe('');
    });
  });
});
