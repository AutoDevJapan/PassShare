/**
 * Tests for seed file parsers.
 */

import { describe, it, expect } from 'vitest';
import { parseEnvFile } from '../../src/seed/parsers/env.js';
import { parseJsonFile } from '../../src/seed/parsers/json.js';
import { parseYamlFile } from '../../src/seed/parsers/yaml.js';
import { parseCsvFile } from '../../src/seed/parsers/csv.js';
import { parseJavaScriptFile } from '../../src/seed/parsers/javascript.js';
import { parsePythonFile } from '../../src/seed/parsers/python.js';

describe('parseEnvFile', () => {
  it('should parse simple key-value pairs', async () => {
    const content = `
EMAIL=test@example.com
PASSWORD=secret123
    `;
    const result = await parseEnvFile(content, '.env');
    expect(result).toEqual({
      EMAIL: 'test@example.com',
      PASSWORD: 'secret123',
    });
  });

  it('should handle quoted values', async () => {
    const content = `
EMAIL="test@example.com"
PASSWORD='has spaces'
    `;
    const result = await parseEnvFile(content, '.env');
    expect(result).toEqual({
      EMAIL: 'test@example.com',
      PASSWORD: 'has spaces',
    });
  });

  it('should ignore comments and empty lines', async () => {
    const content = `
# This is a comment
EMAIL=test@example.com

# Another comment
PASSWORD=secret
    `;
    const result = await parseEnvFile(content, '.env');
    expect(result).toEqual({
      EMAIL: 'test@example.com',
      PASSWORD: 'secret',
    });
  });

  it('should handle export prefix', async () => {
    const content = `
export EMAIL=test@example.com
export PASSWORD=secret
    `;
    const result = await parseEnvFile(content, '.env');
    expect(result).toEqual({
      EMAIL: 'test@example.com',
      PASSWORD: 'secret',
    });
  });
});

describe('parseJsonFile', () => {
  it('should parse simple object', async () => {
    const content = `{
      "email": "test@example.com",
      "password": "secret123"
    }`;
    const result = await parseJsonFile(content, 'data.json');
    expect(result).toEqual({
      email: 'test@example.com',
      password: 'secret123',
    });
  });

  it('should parse array of objects', async () => {
    const content = `[
      {"email": "alice@example.com", "password": "pass1"},
      {"email": "bob@example.com", "password": "pass2"}
    ]`;
    const result = await parseJsonFile(content, 'users.json');
    expect(result).toEqual([
      { email: 'alice@example.com', password: 'pass1' },
      { email: 'bob@example.com', password: 'pass2' },
    ]);
  });

  it('should strip single-line comments (JSONC)', async () => {
    const content = `{
      // This is a comment
      "email": "test@example.com",
      "password": "secret" // inline comment
    }`;
    const result = await parseJsonFile(content, 'config.jsonc');
    expect(result).toEqual({
      email: 'test@example.com',
      password: 'secret',
    });
  });

  it('should return null for invalid JSON', async () => {
    const content = '{ invalid json }';
    const result = await parseJsonFile(content, 'bad.json');
    expect(result).toBeNull();
  });
});

describe('parseYamlFile', () => {
  it('should parse simple key-value pairs', async () => {
    const content = `
email: test@example.com
password: secret123
    `;
    const result = await parseYamlFile(content, 'config.yaml');
    expect(result).toEqual({
      email: 'test@example.com',
      password: 'secret123',
    });
  });

  it('should parse nested objects', async () => {
    const content = `
user:
  email: test@example.com
  password: secret
    `;
    const result = await parseYamlFile(content, 'config.yaml');
    expect(result).toEqual({
      user: {
        email: 'test@example.com',
        password: 'secret',
      },
    });
  });

  it('should parse arrays', async () => {
    const content = `
users:
  - email: alice@example.com
    password: pass1
  - email: bob@example.com
    password: pass2
    `;
    const result = await parseYamlFile(content, 'users.yaml');
    expect(result).toEqual({
      users: [
        { email: 'alice@example.com', password: 'pass1' },
        { email: 'bob@example.com', password: 'pass2' },
      ],
    });
  });
});

describe('parseCsvFile', () => {
  it('should parse CSV with headers', async () => {
    const content = `email,password,name
alice@example.com,pass1,Alice
bob@example.com,pass2,Bob`;
    const result = await parseCsvFile(content, 'users.csv');
    expect(result).toEqual([
      { email: 'alice@example.com', password: 'pass1', name: 'Alice' },
      { email: 'bob@example.com', password: 'pass2', name: 'Bob' },
    ]);
  });

  it('should handle quoted values', async () => {
    const content = `email,password
"alice@example.com","has,comma"`;
    const result = await parseCsvFile(content, 'users.csv');
    expect(result).toEqual([
      { email: 'alice@example.com', password: 'has,comma' },
    ]);
  });

  it('should return null for empty CSV', async () => {
    const content = 'email,password';
    const result = await parseCsvFile(content, 'empty.csv');
    expect(result).toBeNull();
  });
});

describe('parseJavaScriptFile', () => {
  it('should extract object literals with credentials', async () => {
    const content = `
const user = {
  email: "test@example.com",
  password: "secret123"
};
    `;
    const result = await parseJavaScriptFile(content, 'seed.js');
    expect(result).toBeTruthy();
    expect(Array.isArray(result) || typeof result === 'object').toBe(true);
  });

  it('should extract variable assignments', async () => {
    const content = `
const EMAIL = "admin@example.com";
const PASSWORD = "supersecret";
    `;
    const result = await parseJavaScriptFile(content, 'config.js');
    expect(result).toBeTruthy();
  });

  it('should handle ES module exports', async () => {
    const content = `
export const users = [
  { email: "alice@example.com", password: "pass1" },
  { email: "bob@example.com", password: "pass2" }
];
    `;
    const result = await parseJavaScriptFile(content, 'seed.ts');
    expect(result).toBeTruthy();
  });
});

describe('parsePythonFile', () => {
  it('should extract dictionary literals', async () => {
    const content = `
user = {
    "email": "test@example.com",
    "password": "secret123"
}
    `;
    const result = await parsePythonFile(content, 'seed.py');
    expect(result).toBeTruthy();
  });

  it('should extract list of dictionaries', async () => {
    const content = `
USERS = [
    {"email": "alice@example.com", "password": "pass1"},
    {"email": "bob@example.com", "password": "pass2"},
]
    `;
    const result = await parsePythonFile(content, 'seeds.py');
    expect(result).toBeTruthy();
  });

  it('should extract uppercase constant assignments', async () => {
    const content = `
EMAIL = "admin@example.com"
PASSWORD = "supersecret"
    `;
    const result = await parsePythonFile(content, 'config.py');
    expect(result).toBeTruthy();
  });
});
