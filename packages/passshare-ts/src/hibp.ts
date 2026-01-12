/**
 * Have I Been Pwned (HIBP) integration for PassShare.
 *
 * Uses the k-anonymity API to check if passwords have been compromised
 * without sending the full password hash.
 *
 * API: https://haveibeenpwned.com/API/v3#PwnedPasswords
 *
 * © 2026 BM1314 Inc. All rights reserved.
 */

import * as crypto from 'crypto';

/**
 * HIBP API base URL
 */
const HIBP_API_BASE = 'https://api.pwnedpasswords.com/range/';

/**
 * Result of a HIBP password check
 */
export interface HIBPCheckResult {
  /** Whether the password was found in breaches */
  pwned: boolean;
  /** Number of times the password appeared in breaches (0 if not found) */
  count: number;
}

/**
 * Result of checking multiple passwords
 */
export interface HIBPBatchResult {
  /** Password or identifier */
  name: string;
  /** Check result */
  result: HIBPCheckResult;
  /** Any error that occurred */
  error?: string;
}

/**
 * Check if a password has been compromised using HIBP k-anonymity API.
 *
 * This method is privacy-preserving:
 * 1. SHA-1 hash the password
 * 2. Send only the first 5 characters of the hash
 * 3. HIBP returns all hashes starting with those 5 chars
 * 4. We check locally if our full hash is in the list
 *
 * @param password - The password to check
 * @returns Check result with pwned status and count
 */
export async function checkPassword(password: string): Promise<HIBPCheckResult> {
  // Hash the password using SHA-1
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();

  // Split into prefix (first 5 chars) and suffix (rest)
  const prefix = hash.substring(0, 5);
  const suffix = hash.substring(5);

  try {
    // Fetch matching hashes from HIBP
    const response = await fetch(`${HIBP_API_BASE}${prefix}`, {
      headers: {
        'User-Agent': 'PassShare/1.0',
        'Add-Padding': 'true', // Request padding to prevent timing attacks
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Rate limited by HIBP API. Please try again later.');
      }
      throw new Error(`HIBP API error: ${response.status}`);
    }

    const text = await response.text();

    // Parse response - format: SUFFIX:COUNT
    const lines = text.split('\r\n').filter(line => line.trim());

    for (const line of lines) {
      const [hashSuffix, countStr] = line.split(':');
      if (hashSuffix.toUpperCase() === suffix) {
        return {
          pwned: true,
          count: parseInt(countStr, 10) || 0,
        };
      }
    }

    // Not found in breaches
    return { pwned: false, count: 0 };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to check password: ${error}`);
  }
}

/**
 * Check multiple passwords with rate limiting.
 *
 * @param passwords - Array of password/name pairs
 * @param delayMs - Delay between requests to avoid rate limiting (default: 100ms)
 * @returns Array of results
 */
export async function checkPasswordsBatch(
  passwords: Array<{ name: string; password: string }>,
  delayMs: number = 100
): Promise<HIBPBatchResult[]> {
  const results: HIBPBatchResult[] = [];

  for (let i = 0; i < passwords.length; i++) {
    const { name, password } = passwords[i];

    try {
      const result = await checkPassword(password);
      results.push({ name, result });
    } catch (error) {
      results.push({
        name,
        result: { pwned: false, count: 0 },
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Delay between requests (except for the last one)
    if (i < passwords.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Check if an email has been in any known breaches.
 *
 * Note: This requires an HIBP API key for the breached accounts API.
 *
 * @param email - The email to check
 * @param apiKey - HIBP API key
 * @returns Array of breach names
 */
export async function checkEmail(email: string, apiKey: string): Promise<string[]> {
  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'hibp-api-key': apiKey,
        'User-Agent': 'PassShare/1.0',
      },
    });

    if (response.status === 404) {
      // Not found - email not in any breaches
      return [];
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid HIBP API key');
      }
      if (response.status === 429) {
        throw new Error('Rate limited by HIBP API. Please try again later.');
      }
      throw new Error(`HIBP API error: ${response.status}`);
    }

    const breaches = await response.json() as Array<{ Name: string }>;
    return breaches.map(b => b.Name);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to check email: ${error}`);
  }
}

/**
 * Format the HIBP count for display
 */
export function formatPwnedCount(count: number): string {
  if (count === 0) return '0';
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}
