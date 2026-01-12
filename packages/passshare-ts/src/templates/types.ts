/**
 * Template Types for PassShare
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

/**
 * Template field definition
 */
export interface TemplateField {
  /** Field name (key) */
  name: string;
  /** Display label */
  label: string;
  /** Field type */
  type: 'text' | 'password' | 'email' | 'url' | 'number' | 'date' | 'multiline' | 'hidden';
  /** Whether the field is required */
  required?: boolean;
  /** Default value */
  default?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Generate password for this field */
  generate?: boolean;
  /** Validation pattern (regex) */
  pattern?: string;
}

/**
 * Template definition
 */
export interface Template {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Icon (emoji or icon name) */
  icon: string;
  /** Category */
  category: 'login' | 'card' | 'identity' | 'secure-note' | 'developer' | 'custom';
  /** Fields */
  fields: TemplateField[];
  /** Suggested folder prefix */
  prefix?: string;
  /** Priority (for sorting) */
  priority?: number;
}

/**
 * Template manager options
 */
export interface TemplateManagerOptions {
  /** Custom templates directory */
  templatesDir?: string;
  /** Include built-in templates */
  includeBuiltIn?: boolean;
}
