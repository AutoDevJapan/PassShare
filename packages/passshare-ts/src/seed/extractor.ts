/**
 * Credential extraction from parsed data.
 */

import {
  DetectedCredential,
  CredentialGroup,
  DEFAULT_CREDENTIAL_FIELDS,
} from './types.js';

/**
 * Extracts credentials from parsed data structures.
 */
export class CredentialExtractor {
  private readonly _fields: Set<string>;
  private readonly _fieldPatterns: RegExp[];

  /**
   * Create a new extractor.
   *
   * @param customFields - Additional fields to detect
   */
  constructor(customFields: string[] = []) {
    const allFields = [...DEFAULT_CREDENTIAL_FIELDS, ...customFields];
    this._fields = new Set(allFields.map((f) => f.toLowerCase()));

    // Create regex patterns for flexible matching
    this._fieldPatterns = allFields.map(
      (f) => new RegExp(`^${f.replace(/[_-]/g, '[_-]?')}$`, 'i')
    );
  }

  /**
   * Check if a field name matches any credential field.
   */
  isCredentialField(fieldName: string): boolean {
    const normalized = fieldName.toLowerCase().trim();

    // Direct match
    if (this._fields.has(normalized)) {
      return true;
    }

    // Pattern match (e.g., user_email matches useremail)
    return this._fieldPatterns.some((p) => p.test(normalized));
  }

  /**
   * Extract credentials from a flat key-value map (e.g., .env file).
   */
  extractFromKeyValue(
    data: Record<string, string>,
    file: string
  ): DetectedCredential[] {
    const credentials: DetectedCredential[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (this.isCredentialField(key) && value && typeof value === 'string') {
        credentials.push({
          file,
          field: key,
          value: value.trim(),
        });
      }
    }

    return credentials;
  }

  /**
   * Extract credentials from a nested object (e.g., JSON/YAML).
   */
  extractFromObject(
    data: unknown,
    file: string,
    context: string = ''
  ): DetectedCredential[] {
    const credentials: DetectedCredential[] = [];

    if (data === null || data === undefined) {
      return credentials;
    }

    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        const newContext = context ? `${context}[${index}]` : `[${index}]`;
        credentials.push(...this.extractFromObject(item, file, newContext));
      });
    } else if (typeof data === 'object') {
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const newContext = context ? `${context}.${key}` : key;

        if (this.isCredentialField(key)) {
          if (typeof value === 'string' && value.trim()) {
            credentials.push({
              file,
              field: key,
              value: value.trim(),
              context: newContext,
            });
          } else if (typeof value === 'number') {
            credentials.push({
              file,
              field: key,
              value: String(value),
              context: newContext,
            });
          }
        }

        // Recurse into nested objects
        if (value !== null && typeof value === 'object') {
          credentials.push(...this.extractFromObject(value, file, newContext));
        }
      }
    }

    return credentials;
  }

  /**
   * Group detected credentials by their context.
   * For example, group email + password from the same user object.
   */
  groupCredentials(
    credentials: DetectedCredential[],
    projectName: string
  ): CredentialGroup[] {
    const groups: Map<string, CredentialGroup> = new Map();

    for (const cred of credentials) {
      // Determine group key based on context
      const groupKey = this.getGroupKey(cred);

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          file: cred.file,
          name: this.generateName(cred, projectName),
          extras: {},
        });
      }

      const group = groups.get(groupKey)!;
      const fieldLower = cred.field.toLowerCase();

      // Categorize the field
      if (this.isEmailField(fieldLower)) {
        group.email = cred.value;
      } else if (this.isPasswordField(fieldLower)) {
        group.password = cred.value;
      } else {
        group.extras[cred.field] = cred.value;
      }
    }

    return Array.from(groups.values());
  }

  private getGroupKey(cred: DetectedCredential): string {
    // Use context path up to the parent object
    if (cred.context) {
      const parts = cred.context.split('.');
      parts.pop(); // Remove the field name itself
      if (parts.length > 0) {
        return `${cred.file}:${parts.join('.')}`;
      }
    }
    return `${cred.file}:root`;
  }

  private generateName(cred: DetectedCredential, projectName: string): string {
    const parts = [projectName];

    if (cred.context) {
      // Extract meaningful parts from context
      const contextParts = cred.context
        .replace(/\[\d+\]/g, '') // Remove array indices
        .split('.')
        .filter((p) => p && !this.isCredentialField(p));

      if (contextParts.length > 0) {
        parts.push(...contextParts.slice(0, 2)); // Limit depth
      }
    }

    return parts.join('/').toLowerCase().replace(/[^a-z0-9/]/g, '-');
  }

  private isEmailField(field: string): boolean {
    return /^(e-?mail|user_?email)$/i.test(field);
  }

  private isPasswordField(field: string): boolean {
    return /^(pass(word|wd)?|pwd|.*_password)$/i.test(field);
  }
}
