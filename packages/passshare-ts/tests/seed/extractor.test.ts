/**
 * Tests for credential extractor.
 */

import { describe, it, expect } from 'vitest';
import { CredentialExtractor } from '../../src/seed/extractor.js';

describe('CredentialExtractor', () => {
  describe('isCredentialField', () => {
    it('should detect common credential fields', () => {
      const extractor = new CredentialExtractor();

      expect(extractor.isCredentialField('email')).toBe(true);
      expect(extractor.isCredentialField('password')).toBe(true);
      expect(extractor.isCredentialField('username')).toBe(true);
      expect(extractor.isCredentialField('token')).toBe(true);
      expect(extractor.isCredentialField('api_key')).toBe(true);
      expect(extractor.isCredentialField('secret')).toBe(true);
    });

    it('should be case-insensitive', () => {
      const extractor = new CredentialExtractor();

      expect(extractor.isCredentialField('EMAIL')).toBe(true);
      expect(extractor.isCredentialField('Password')).toBe(true);
      expect(extractor.isCredentialField('API_KEY')).toBe(true);
    });

    it('should handle variations', () => {
      const extractor = new CredentialExtractor();

      expect(extractor.isCredentialField('user_email')).toBe(true);
      expect(extractor.isCredentialField('db_password')).toBe(true);
      expect(extractor.isCredentialField('apikey')).toBe(true);
    });

    it('should detect custom fields', () => {
      const extractor = new CredentialExtractor(['myfield', 'custom_token']);

      expect(extractor.isCredentialField('myfield')).toBe(true);
      expect(extractor.isCredentialField('custom_token')).toBe(true);
    });

    it('should not match non-credential fields', () => {
      const extractor = new CredentialExtractor();

      expect(extractor.isCredentialField('name')).toBe(false);
      expect(extractor.isCredentialField('age')).toBe(false);
      expect(extractor.isCredentialField('description')).toBe(false);
    });
  });

  describe('extractFromKeyValue', () => {
    it('should extract credentials from flat key-value pairs', () => {
      const extractor = new CredentialExtractor();
      const data = {
        EMAIL: 'test@example.com',
        PASSWORD: 'secret123',
        NAME: 'Test User',
      };

      const result = extractor.extractFromKeyValue(data, '.env');

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        file: '.env',
        field: 'EMAIL',
        value: 'test@example.com',
      });
      expect(result).toContainEqual({
        file: '.env',
        field: 'PASSWORD',
        value: 'secret123',
      });
    });

    it('should skip empty values', () => {
      const extractor = new CredentialExtractor();
      const data = {
        EMAIL: '',
        PASSWORD: 'secret',
      };

      const result = extractor.extractFromKeyValue(data, '.env');

      expect(result).toHaveLength(1);
      expect(result[0].field).toBe('PASSWORD');
    });
  });

  describe('extractFromObject', () => {
    it('should extract from nested objects', () => {
      const extractor = new CredentialExtractor();
      const data = {
        user: {
          email: 'test@example.com',
          password: 'secret123',
          name: 'Test',
        },
      };

      const result = extractor.extractFromObject(data, 'config.json');

      expect(result).toHaveLength(2);
      expect(result.some((c) => c.field === 'email')).toBe(true);
      expect(result.some((c) => c.field === 'password')).toBe(true);
    });

    it('should extract from arrays', () => {
      const extractor = new CredentialExtractor();
      const data = [
        { email: 'alice@example.com', password: 'pass1' },
        { email: 'bob@example.com', password: 'pass2' },
      ];

      const result = extractor.extractFromObject(data, 'users.json');

      expect(result).toHaveLength(4); // 2 emails + 2 passwords
    });

    it('should include context in results', () => {
      const extractor = new CredentialExtractor();
      const data = {
        admin: {
          email: 'admin@example.com',
        },
      };

      const result = extractor.extractFromObject(data, 'config.json');

      expect(result[0].context).toBe('admin.email');
    });
  });

  describe('groupCredentials', () => {
    it('should group related credentials together', () => {
      const extractor = new CredentialExtractor();
      const credentials = [
        { file: 'config.json', field: 'email', value: 'test@example.com', context: 'user.email' },
        { file: 'config.json', field: 'password', value: 'secret', context: 'user.password' },
      ];

      const groups = extractor.groupCredentials(credentials, 'myproject');

      expect(groups).toHaveLength(1);
      expect(groups[0].email).toBe('test@example.com');
      expect(groups[0].password).toBe('secret');
    });

    it('should separate credentials from different contexts', () => {
      const extractor = new CredentialExtractor();
      const credentials = [
        { file: 'config.json', field: 'email', value: 'admin@example.com', context: 'admin.email' },
        { file: 'config.json', field: 'email', value: 'user@example.com', context: 'user.email' },
      ];

      const groups = extractor.groupCredentials(credentials, 'myproject');

      expect(groups).toHaveLength(2);
    });
  });
});
