#!/usr/bin/env node
/**
 * Generate extension icons from the project logo
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..', '..');
const extensionRoot = resolve(__dirname, '..');
const distDir = resolve(extensionRoot, 'dist');
const assetsDir = resolve(distDir, 'assets');

const logoPath = resolve(projectRoot, 'logo.png');
const sizes = [16, 32, 48, 128];

async function generateIcons() {
  console.log('[GenerateIcons] Starting icon generation...');
  console.log('[GenerateIcons] Logo path:', logoPath);
  console.log('[GenerateIcons] Assets dir:', assetsDir);

  // Create assets directory
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
    console.log('[GenerateIcons] Created assets directory');
  }

  // Check if logo exists
  if (!existsSync(logoPath)) {
    console.error('[GenerateIcons] Logo not found:', logoPath);
    process.exit(1);
  }

  // Use Python with Pillow - escape paths properly for Windows
  const escapedLogoPath = logoPath.replace(/\\/g, '/');
  const escapedAssetsDir = assetsDir.replace(/\\/g, '/');
  
  const pythonScript = `
import sys
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image
import os

logo = Image.open(r'${escapedLogoPath}')
if logo.mode != 'RGBA':
    logo = logo.convert('RGBA')

sizes = [${sizes.join(', ')}]
output_dir = r'${escapedAssetsDir}'

if not os.path.exists(output_dir):
    os.makedirs(output_dir, exist_ok=True)

for size in sizes:
    resized = logo.resize((size, size), Image.Resampling.LANCZOS)
    output_path = os.path.join(output_dir, f'icon-{size}.png')
    resized.save(output_path, 'PNG')
    print(f'Created: icon-{size}.png')

print('Done!')
`;

  try {
    // Write script to temp file to avoid command line escaping issues
    const tempScript = resolve(distDir, '_generate_icons.py');
    writeFileSync(tempScript, pythonScript, 'utf-8');
    
    execSync(`python "${tempScript}"`, { 
      stdio: 'inherit',
      encoding: 'utf-8'
    });
    
    // Clean up temp file
    const { unlinkSync } = await import('fs');
    try { unlinkSync(tempScript); } catch {}
    
    console.log('[GenerateIcons] Icons generated successfully');
  } catch (error) {
    console.error('[GenerateIcons] Failed to generate icons:', error.message);
    
    // Fallback: copy logo as all sizes
    console.warn('[GenerateIcons] Using logo as fallback');
    for (const size of sizes) {
      const outputPath = resolve(assetsDir, `icon-${size}.png`);
      copyFileSync(logoPath, outputPath);
      console.log(`[GenerateIcons] Copied logo as icon-${size}.png`);
    }
  }
}

generateIcons().catch(console.error);
