/**
 * Template Manager for PassShare
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_TEMPLATES } from './builtin.js';
import type { Template, TemplateField, TemplateManagerOptions } from './types.js';
import { Secret } from '../secret.js';
import { generatePassword } from '../password.js';

/**
 * Template manager for creating secrets from templates
 */
export class TemplateManager {
  private templates: Map<string, Template> = new Map();
  private customTemplatesDir?: string;

  constructor(options: TemplateManagerOptions = {}) {
    this.customTemplatesDir = options.templatesDir;

    // Load built-in templates
    if (options.includeBuiltIn !== false) {
      for (const template of BUILTIN_TEMPLATES) {
        this.templates.set(template.id, template);
      }
    }

    // Load custom templates
    if (this.customTemplatesDir) {
      this.loadCustomTemplates(this.customTemplatesDir);
    }
  }

  /**
   * Load custom templates from a directory
   */
  private loadCustomTemplates(dir: string): void {
    if (!fs.existsSync(dir)) {
      return;
    }

    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json') && !file.endsWith('.yaml') && !file.endsWith('.yml')) {
        continue;
      }

      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const template = JSON.parse(content) as Template;
        this.templates.set(template.id, template);
      } catch {
        // Skip invalid templates
      }
    }
  }

  /**
   * Get all templates
   */
  getAll(): Template[] {
    return Array.from(this.templates.values()).sort(
      (a, b) => (a.priority || 99) - (b.priority || 99)
    );
  }

  /**
   * Get templates by category
   */
  getByCategory(category: Template['category']): Template[] {
    return this.getAll().filter((t) => t.category === category);
  }

  /**
   * Get a specific template by ID
   */
  get(id: string): Template | undefined {
    return this.templates.get(id);
  }

  /**
   * Add a custom template
   */
  add(template: Template): void {
    this.templates.set(template.id, template);
  }

  /**
   * Remove a template
   */
  remove(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Create a Secret from a template with provided values
   */
  createSecret(templateId: string, values: Record<string, string>): Secret {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Get password field
    const passwordField = template.fields.find(
      (f) => f.name === 'password' || f.type === 'password'
    );
    let password = values.password || values[passwordField?.name || 'password'] || '';

    // Generate password if needed
    if (!password && passwordField?.generate) {
      password = generatePassword({ length: 24, symbols: true });
    }

    const secret = new Secret(password);

    // Set all other fields
    for (const field of template.fields) {
      if (field.name === 'password') continue;

      let value = values[field.name];

      // Use default if not provided
      if (!value && field.default) {
        value = field.default;
      }

      // Generate if needed
      if (!value && field.generate) {
        value = generatePassword({ length: 24, symbols: true });
      }

      if (value) {
        if (field.name === 'notes' || field.name === 'content') {
          secret.body = value;
        } else {
          secret.set(field.name, value);
        }
      }
    }

    return secret;
  }

  /**
   * Generate a suggested secret name from template and values
   */
  suggestName(templateId: string, values: Record<string, string>): string {
    const template = this.templates.get(templateId);
    if (!template) {
      return 'secret';
    }

    const prefix = template.prefix || template.category;

    // Try to find a meaningful identifier
    const identifiers = ['url', 'service', 'ssid', 'product', 'host', 'bank_name', 'title'];
    for (const key of identifiers) {
      if (values[key]) {
        // Extract domain from URL
        if (key === 'url') {
          try {
            const url = new URL(values[key]);
            return `${prefix}/${url.hostname.replace('www.', '')}`;
          } catch {
            // Not a valid URL
          }
        }
        return `${prefix}/${values[key].toLowerCase().replace(/\s+/g, '-')}`;
      }
    }

    // Use username or email as identifier
    if (values.username) {
      return `${prefix}/${values.username}`;
    }
    if (values.email) {
      return `${prefix}/${values.email.split('@')[0]}`;
    }

    // Fallback to template id with timestamp
    return `${prefix}/${template.id}-${Date.now()}`;
  }

  /**
   * Validate field value against template definition
   */
  validateField(field: TemplateField, value: string): { valid: boolean; error?: string } {
    // Check required
    if (field.required && !value) {
      return { valid: false, error: `${field.label} is required` };
    }

    // Check pattern
    if (value && field.pattern) {
      const regex = new RegExp(field.pattern);
      if (!regex.test(value)) {
        return { valid: false, error: `${field.label} format is invalid` };
      }
    }

    // Check email format
    if (value && field.type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return { valid: false, error: `${field.label} must be a valid email` };
      }
    }

    // Check URL format
    if (value && field.type === 'url') {
      try {
        new URL(value);
      } catch {
        return { valid: false, error: `${field.label} must be a valid URL` };
      }
    }

    // Check number format
    if (value && field.type === 'number') {
      if (isNaN(Number(value))) {
        return { valid: false, error: `${field.label} must be a number` };
      }
    }

    return { valid: true };
  }

  /**
   * Validate all values against template
   */
  validate(templateId: string, values: Record<string, string>): { valid: boolean; errors: Record<string, string> } {
    const template = this.templates.get(templateId);
    if (!template) {
      return { valid: false, errors: { _template: 'Template not found' } };
    }

    const errors: Record<string, string> = {};

    for (const field of template.fields) {
      const result = this.validateField(field, values[field.name] || '');
      if (!result.valid && result.error) {
        errors[field.name] = result.error;
      }
    }

    return { valid: Object.keys(errors).length === 0, errors };
  }

  /**
   * Export template to JSON
   */
  exportTemplate(id: string): string | null {
    const template = this.templates.get(id);
    if (!template) {
      return null;
    }
    return JSON.stringify(template, null, 2);
  }

  /**
   * Import template from JSON
   */
  importTemplate(json: string): Template {
    const template = JSON.parse(json) as Template;

    // Validate required fields
    if (!template.id || !template.name || !template.fields) {
      throw new Error('Invalid template: missing required fields');
    }

    this.templates.set(template.id, template);
    return template;
  }
}

/**
 * Default template manager instance
 */
export const defaultTemplateManager = new TemplateManager();
