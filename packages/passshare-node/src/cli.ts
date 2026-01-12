#!/usr/bin/env node
/**
 * PassShare CLI - Command Line Interface
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  Gopass,
  Secret,
  generatePassword,
  checkPasswordStrength,
  copyToClipboard,
  VERSION,
  NotFoundError,
  PassShareError,
  SeedScanner,
  importPasswords,
  exportPasswords,
  hibpCheckPassword,
  formatPwnedCount,
  type ScanResult,
  type ImportSource,
  type ExportFormat,
} from '@bm1314/passshare-core';

const program = new Command();

function getGopass(): Gopass {
  return new Gopass();
}

function handleError(error: unknown): never {
  if (error instanceof NotFoundError) {
    console.error(chalk.red(`Error: Secret not found: ${error.secretName}`));
    process.exit(10);
  }
  if (error instanceof PassShareError) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
  console.error(chalk.red(`Error: ${error}`));
  process.exit(1);
}

program
  .name('passshare')
  .description('A gopass-compatible password manager')
  .version(VERSION);

// Show command
program
  .command('show [name] [key]')
  .description('Show a secret')
  .option('-c, --clip', 'Copy to clipboard')
  .option('-C, --alsoclip', 'Print and copy to clipboard')
  .option('-o, --password', 'Show password only')
  .option('-n, --noparsing', 'Show raw content')
  .option('-r, --revision <rev>', 'Show specific revision')
  .action(async (name, key, options) => {
    try {
      if (!name) {
        // List mode
        const gopass = getGopass();
        const secrets = await gopass.list();
        printTree(secrets);
        return;
      }

      const gopass = getGopass();
      let secret: Secret;

      if (options.revision) {
        secret = await gopass.showRevision(name, options.revision);
      } else {
        secret = await gopass.get(name);
      }

      let output: string;
      if (key) {
        output = secret.get(key);
      } else if (options.password) {
        output = secret.password;
      } else {
        output = secret.toString();
      }

      if (options.clip || options.alsoclip) {
        const copyText = key ? output : secret.password;
        await copyToClipboard(copyText);
        if (options.clip && !options.alsoclip) {
          console.log(chalk.green(`Copied ${name} to clipboard. Will clear in 45 seconds.`));
          return;
        }
      }

      console.log(output);
    } catch (error) {
      handleError(error);
    }
  });

// Default command (show)
program
  .argument('[name]', 'Secret name to show')
  .action(async (name) => {
    if (name && !program.args.includes(name)) {
      await program.parseAsync(['show', name], { from: 'user' });
    }
  });

// Init command
program
  .command('init <gpg-ids...>')
  .description('Initialize a new password store')
  .option('-s, --store <name>', 'Store name (for mounts)')
  .option('-p, --path <path>', 'Store path')
  .option('--crypto <backend>', 'Crypto backend (gpg, age)', 'gpg')
  .option('--storage <backend>', 'Storage backend (gitfs, fs)', 'gitfs')
  .action(async (gpgIds, options) => {
    try {
      const gopass = getGopass();
      await gopass.init(gpgIds, options.path, options.crypto, options.storage);
      console.log(chalk.green(`Password store initialized`));
    } catch (error) {
      handleError(error);
    }
  });

// Insert command
program
  .command('insert <name>')
  .description('Insert a new secret')
  .option('-e, --echo', 'Echo input')
  .option('-m, --multiline', 'Multiline input')
  .option('-f, --force', 'Overwrite existing')
  .action(async (name, options) => {
    try {
      const gopass = getGopass();

      if ((await gopass.exists(name)) && !options.force) {
        console.error(chalk.yellow(`Secret ${name} already exists. Use -f to overwrite.`));
        process.exit(1);
      }

      // Read from stdin
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const lines: string[] = [];

      if (options.multiline) {
        console.log('Enter secret (Ctrl+D to finish):');
        for await (const line of rl) {
          lines.push(line);
        }
      } else {
        const password = await new Promise<string>((resolve) => {
          rl.question('Enter secret: ', (answer) => {
            rl.close();
            resolve(answer);
          });
        });
        lines.push(password);
      }

      const content = lines.join('\n');
      const secret = Secret.parse(content);
      await gopass.set(name, secret);

      console.log(chalk.green(`Saved ${name}`));
    } catch (error) {
      handleError(error);
    }
  });

// Delete command
program
  .command('delete <name>')
  .alias('rm')
  .description('Delete a secret')
  .option('-f, --force', 'Skip confirmation')
  .option('-r, --recursive', 'Delete recursively')
  .action(async (name, options) => {
    try {
      const gopass = getGopass();

      if (options.recursive) {
        const secrets = (await gopass.list()).filter((s) => s.startsWith(name));
        if (!secrets.length) {
          throw new NotFoundError(name);
        }

        if (!options.force) {
          console.log(`Will delete ${secrets.length} secrets`);
          // In a real implementation, we'd prompt for confirmation
        }

        for (const s of secrets) {
          await gopass.delete(s);
          console.log(chalk.green(`Deleted ${s}`));
        }
      } else {
        await gopass.delete(name);
        console.log(chalk.green(`Deleted ${name}`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// Generate command
program
  .command('generate <name> [length]')
  .description('Generate a password')
  .option('-c, --clip', 'Copy to clipboard')
  .option('-p, --print', 'Print password')
  .option('-f, --force', 'Overwrite existing')
  .option('-n, --no-symbols', 'No symbols')
  .option('-x, --xkcd', 'XKCD-style password')
  .option('--sep <separator>', 'XKCD separator', '-')
  .action(async (name, length, options) => {
    try {
      const gopass = getGopass();
      const len = parseInt(length) || 24;

      const password = await gopass.generate(name, {
        length: len,
        symbols: options.symbols !== false,
        xkcd: options.xkcd,
        force: options.force,
      });

      if (options.clip) {
        await copyToClipboard(password);
        console.log(chalk.green(`Generated password for ${name}. Copied to clipboard.`));
      } else {
        console.log(chalk.green(`Generated password for ${name}: ${password}`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// List command
program
  .command('list [folder]')
  .alias('ls')
  .description('List secrets')
  .option('-l, --limit <n>', 'Limit results')
  .option('-f, --flat', 'Flat list')
  .action(async (folder, options) => {
    try {
      const gopass = getGopass();
      let secrets = await gopass.list(folder || '');

      if (options.limit) {
        secrets = secrets.slice(0, parseInt(options.limit));
      }

      if (options.flat) {
        secrets.forEach((s) => console.log(s));
      } else {
        printTree(secrets);
      }
    } catch (error) {
      handleError(error);
    }
  });

// Find command
program
  .command('find <pattern>')
  .alias('search')
  .description('Find secrets by name')
  .option('-c, --clip', 'Copy first result to clipboard')
  .action(async (pattern, options) => {
    try {
      const gopass = getGopass();
      const matches = await gopass.find(pattern);

      if (!matches.length) {
        console.log(`No matches found for: ${pattern}`);
        return;
      }

      matches.forEach((m) => console.log(m));

      if (options.clip && matches.length > 0) {
        const secret = await gopass.get(matches[0]);
        await copyToClipboard(secret.password);
        console.log(chalk.green(`\nCopied ${matches[0]} to clipboard.`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// Grep command
program
  .command('grep <pattern>')
  .description('Search secret contents')
  .action(async (pattern) => {
    try {
      const gopass = getGopass();
      const results = await gopass.grep(pattern);

      for (const [name, line] of results) {
        console.log(`${chalk.cyan(name)}: ${line}`);
      }

      if (!results.length) {
        console.log(`No matches found for: ${pattern}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

// Copy command
program
  .command('copy <from> <to>')
  .alias('cp')
  .description('Copy a secret')
  .option('-f, --force', 'Overwrite existing')
  .action(async (from, to, options) => {
    try {
      const gopass = getGopass();
      await gopass.copy(from, to, options.force);
      console.log(chalk.green(`Copied ${from} to ${to}`));
    } catch (error) {
      handleError(error);
    }
  });

// Move command
program
  .command('move <from> <to>')
  .alias('mv')
  .description('Move a secret')
  .option('-f, --force', 'Overwrite existing')
  .action(async (from, to, options) => {
    try {
      const gopass = getGopass();
      await gopass.move(from, to, options.force);
      console.log(chalk.green(`Moved ${from} to ${to}`));
    } catch (error) {
      handleError(error);
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync with remote')
  .option('-s, --store <name>', 'Store to sync')
  .action(async (options) => {
    try {
      const gopass = getGopass();
      await gopass.sync(options.store);
      console.log(chalk.green('Sync complete'));
    } catch (error) {
      handleError(error);
    }
  });

// Config command
program
  .command('config [key] [value]')
  .description('Manage configuration')
  .action(async (key, value) => {
    try {
      const gopass = getGopass();
      const config = gopass.config;

      if (!key) {
        console.log(`path: ${config.storePath}`);
        console.log(`autoclip: ${config.get('autoclip')}`);
        console.log(`cliptimeout: ${config.get('cliptimeout')}`);
        if (config.mounts.size > 0) {
          console.log('mounts:');
          for (const [alias, path] of config.mounts) {
            console.log(`  ${alias}: ${path}`);
          }
        }
      } else if (!value) {
        console.log(`${key}: ${config.get(key)}`);
      } else {
        let parsedValue: unknown = value;
        if (value === 'true') parsedValue = true;
        else if (value === 'false') parsedValue = false;
        else if (/^\d+$/.test(value)) parsedValue = parseInt(value);

        config.set(key, parsedValue);
        config.save();
        console.log(chalk.green(`Set ${key} = ${value}`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// Mounts command
program
  .command('mounts [action] [args...]')
  .description('Manage mount points')
  .action(async (action, args) => {
    try {
      const gopass = getGopass();

      if (!action) {
        if (gopass.mounts.size === 0) {
          console.log('No mounts configured');
        } else {
          for (const [alias, path] of gopass.mounts) {
            console.log(`${alias}: ${path}`);
          }
        }
      } else if (action === 'add') {
        if (args.length !== 2) {
          console.error('Usage: passshare mounts add <alias> <path>');
          process.exit(2);
        }
        gopass.mount(args[0], args[1]);
        console.log(chalk.green(`Added mount ${args[0]} -> ${args[1]}`));
      } else if (action === 'remove') {
        if (args.length !== 1) {
          console.error('Usage: passshare mounts remove <alias>');
          process.exit(2);
        }
        gopass.unmount(args[0]);
        console.log(chalk.green(`Removed mount ${args[0]}`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// Recipients command
program
  .command('recipients [action] [key-id]')
  .description('Manage recipients')
  .option('-s, --store <name>', 'Store name')
  .action(async (action, keyId, options) => {
    try {
      const gopass = getGopass();

      if (!action) {
        const recipients = gopass.recipients(options.store);
        if (!recipients.length) {
          console.log('No recipients configured');
        } else {
          recipients.forEach((r) => console.log(r));
        }
      } else if (action === 'add') {
        if (!keyId) {
          console.error('Usage: passshare recipients add <key-id>');
          process.exit(2);
        }
        await gopass.addRecipient(keyId, options.store);
        console.log(chalk.green(`Added recipient ${keyId}`));
      } else if (action === 'remove') {
        if (!keyId) {
          console.error('Usage: passshare recipients remove <key-id>');
          process.exit(2);
        }
        await gopass.removeRecipient(keyId, options.store);
        console.log(chalk.green(`Removed recipient ${keyId}`));
      }
    } catch (error) {
      handleError(error);
    }
  });

// OTP command
program
  .command('otp <name>')
  .description('Generate OTP code')
  .option('-c, --clip', 'Copy to clipboard')
  .action(async (name, options) => {
    try {
      const gopass = getGopass();
      const secret = await gopass.get(name);
      const code = secret.otp();

      if (!code) {
        console.error(chalk.red(`No OTP configured for ${name}`));
        process.exit(1);
      }

      if (options.clip) {
        await copyToClipboard(code);
        console.log(chalk.green(`Copied OTP to clipboard: ${code}`));
      } else {
        console.log(code);
      }
    } catch (error) {
      handleError(error);
    }
  });

// Audit command
program
  .command('audit [folder]')
  .description('Audit password strength and check for breaches')
  .option('--hibp', 'Check passwords against Have I Been Pwned database')
  .option('--full', 'Show all details')
  .action(async (folder, options) => {
    try {
      const gopass = getGopass();
      const secrets = await gopass.list(folder || '');

      console.log(`Auditing ${secrets.length} secrets...`);

      const weakPasswords: Array<{ name: string; strength: ReturnType<typeof checkPasswordStrength> }> = [];
      const pwnedPasswords: Array<{ name: string; count: number }> = [];
      const duplicates: Map<string, string[]> = new Map();
      const passwordsToCheck: Array<{ name: string; password: string }> = [];

      // First pass: collect passwords and check strength
      for (const name of secrets) {
        try {
          const secret = await gopass.get(name);
          const password = secret.password;

          if (!password) continue;

          const strength = checkPasswordStrength(password);

          if (strength.strength === 'weak' || strength.strength === 'fair') {
            weakPasswords.push({ name, strength });
          }

          if (!duplicates.has(password)) {
            duplicates.set(password, []);
          }
          duplicates.get(password)!.push(name);

          if (options.hibp) {
            passwordsToCheck.push({ name, password });
          }
        } catch {
          // Skip
        }
      }

      // HIBP check if enabled
      if (options.hibp && passwordsToCheck.length > 0) {
        console.log(chalk.cyan('\nChecking passwords against Have I Been Pwned...'));
        console.log(chalk.gray('(This may take a while for large vaults)\n'));

        let checked = 0;
        for (const { name, password } of passwordsToCheck) {
          try {
            const result = await hibpCheckPassword(password);
            checked++;

            // Progress indicator
            if (checked % 10 === 0) {
              process.stdout.write(`\r  Checked ${checked}/${passwordsToCheck.length}...`);
            }

            if (result.pwned) {
              pwnedPasswords.push({ name, count: result.count });
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (e) {
            // Skip on error
          }
        }
        console.log(`\r  Checked ${checked}/${passwordsToCheck.length} passwords.`);
      }

      // Report results
      let hasIssues = false;

      if (pwnedPasswords.length) {
        hasIssues = true;
        console.log(chalk.red('\n⚠️  COMPROMISED PASSWORDS (found in data breaches):'));
        for (const { name, count } of pwnedPasswords) {
          console.log(chalk.red(`  ✗ ${name}: appeared ${formatPwnedCount(count)} times in breaches`));
        }
      }

      if (weakPasswords.length) {
        hasIssues = true;
        console.log(chalk.yellow('\n⚠️  Weak passwords:'));
        for (const { name, strength } of weakPasswords) {
          console.log(`  ${name}: ${strength.strength} (entropy: ${strength.entropy.toFixed(1)} bits)`);
        }
      }

      const dupGroups = Array.from(duplicates.values()).filter((names) => names.length > 1);
      if (dupGroups.length) {
        hasIssues = true;
        console.log(chalk.yellow('\n⚠️  Duplicate passwords (same password used multiple times):'));
        for (const names of dupGroups) {
          console.log(`  ${names.join(', ')}`);
        }
      }

      // Summary
      console.log('\n' + chalk.bold('Summary:'));
      console.log(`  Total secrets: ${secrets.length}`);
      if (options.hibp) {
        console.log(`  Compromised: ${pwnedPasswords.length > 0 ? chalk.red(pwnedPasswords.length.toString()) : chalk.green('0')}`);
      }
      console.log(`  Weak: ${weakPasswords.length > 0 ? chalk.yellow(weakPasswords.length.toString()) : chalk.green('0')}`);
      console.log(`  Duplicate groups: ${dupGroups.length > 0 ? chalk.yellow(dupGroups.length.toString()) : chalk.green('0')}`);

      if (!hasIssues) {
        console.log(chalk.green('\n✅ All passwords look good!'));
      } else {
        console.log(chalk.yellow('\n💡 Consider updating the flagged passwords.'));
      }
    } catch (error) {
      handleError(error);
    }
  });

// Pwgen command
program
  .command('pwgen [length]')
  .description('Generate standalone passwords')
  .option('-n, --no-symbols', 'No symbols')
  .option('-x, --xkcd', 'XKCD-style')
  .option('--count <n>', 'Number of passwords', '1')
  .action((length, options) => {
    const len = parseInt(length) || 24;
    const count = parseInt(options.count) || 1;

    const passwords: string[] = [];
    for (let i = 0; i < count; i++) {
      passwords.push(
        generatePassword({
          length: len,
          symbols: options.symbols !== false,
          xkcd: options.xkcd,
        })
      );
    }

    console.log(passwords.join(' '));
  });

// Edit command
program
  .command('edit <name>')
  .description('Edit a secret')
  .option('-e, --editor <editor>', 'Editor to use')
  .option('-c, --create', 'Create if not exists')
  .action(async (name, options) => {
    try {
      const gopass = getGopass();
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const { spawn } = await import('child_process');

      let content = '';

      if (await gopass.exists(name)) {
        const secret = await gopass.get(name);
        content = secret.toString();
      } else if (!options.create) {
        throw new NotFoundError(name);
      }

      // Determine editor
      const editor = options.editor || process.env.EDITOR || 'vim';

      // Create temp file
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `passshare-${Date.now()}.txt`);
      fs.writeFileSync(tempFile, content, { mode: 0o600 });

      // Open editor
      const child = spawn(editor, [tempFile], {
        stdio: 'inherit',
        shell: true,
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Editor exited with code ${code}`));
          }
        });
        child.on('error', reject);
      });

      // Read back and save
      const newContent = fs.readFileSync(tempFile, 'utf-8');
      const newSecret = Secret.parse(newContent);
      await gopass.set(name, newSecret);

      // Clean up
      fs.unlinkSync(tempFile);

      console.log(chalk.green(`Saved ${name}`));
    } catch (error) {
      handleError(error);
    }
  });

// History command
program
  .command('history <name>')
  .description('Show secret history')
  .action(async (name) => {
    try {
      const gopass = getGopass();
      const history = await gopass.history(name);

      if (!history.length) {
        console.log(`No history available for ${name}`);
        return;
      }

      console.log(`History for ${name}:`);
      for (const entry of history) {
        console.log(`  * ${entry.date} - ${entry.message}`);
      }
    } catch (error) {
      handleError(error);
    }
  });

// Scan command
program
  .command('scan <directory>')
  .description('Scan directory for seed data and import credentials to vault')
  .option('-n, --name <name>', 'Vault name (default: directory name)')
  .option('-f, --fields <fields>', 'Additional fields to detect (comma-separated)')
  .option('--dry-run', 'Show detected credentials without importing')
  .option('--force', 'Overwrite existing entries')
  .action(async (directory, options) => {
    try {
      const customFields = options.fields
        ? options.fields.split(',').map((f: string) => f.trim())
        : [];

      const scanner = new SeedScanner({ customFields });
      console.log(chalk.cyan(`Scanning ${directory}...`));

      const result: ScanResult = await scanner.scan(directory, options.name);

      // Print summary
      console.log('');
      console.log(chalk.bold(`Project: ${result.projectName}`));
      console.log(`Scanned files: ${result.scannedFiles.length}`);
      console.log(`Skipped files: ${result.skippedFiles.length}`);
      console.log(`Credentials found: ${result.credentials.length}`);

      if (result.errors.length > 0) {
        console.log(chalk.yellow(`\nWarnings: ${result.errors.length}`));
        for (const err of result.errors.slice(0, 5)) {
          console.log(chalk.yellow(`  ${err.file}: ${err.error}`));
        }
        if (result.errors.length > 5) {
          console.log(chalk.yellow(`  ... and ${result.errors.length - 5} more`));
        }
      }

      if (result.credentials.length === 0) {
        console.log(chalk.yellow('\nNo credentials detected.'));
        return;
      }

      // Print detected credentials
      console.log(chalk.bold('\nDetected credentials:'));
      for (const cred of result.credentials) {
        console.log(`\n  ${chalk.green(cred.name)}`);
        console.log(`    File: ${cred.file}`);
        if (cred.email) {
          console.log(`    Email: ${cred.email}`);
        }
        if (cred.password) {
          console.log(`    Password: ${chalk.gray('********')}`);
        }
        const extraKeys = Object.keys(cred.extras);
        if (extraKeys.length > 0) {
          console.log(`    Extras: ${extraKeys.join(', ')}`);
        }
      }

      // Import to vault unless dry-run
      if (options.dryRun) {
        console.log(chalk.cyan('\n--dry-run specified, not importing.'));
        return;
      }

      console.log(chalk.cyan('\nImporting to vault...'));

      const gopass = getGopass();
      let imported = 0;
      let skipped = 0;

      for (const cred of result.credentials) {
        try {
          // Check if already exists
          if ((await gopass.exists(cred.name)) && !options.force) {
            console.log(chalk.yellow(`  Skipped: ${cred.name} (already exists)`));
            skipped++;
            continue;
          }

          // Create secret
          const secret = new Secret(cred.password || '');

          if (cred.email) {
            secret.set('email', cred.email);
            secret.set('username', cred.email);
          }

          for (const [key, value] of Object.entries(cred.extras)) {
            secret.set(key, value);
          }

          // Save
          await gopass.set(cred.name, secret);
          console.log(chalk.green(`  Imported: ${cred.name}`));
          imported++;
        } catch (error) {
          console.error(
            chalk.red(`  Error importing ${cred.name}: ${error}`)
          );
        }
      }

      console.log(chalk.bold(`\nDone: ${imported} imported, ${skipped} skipped`));
    } catch (error) {
      handleError(error);
    }
  });

// Import command
program
  .command('import <source> <file>')
  .description('Import passwords from another password manager')
  .option('-p, --prefix <prefix>', 'Prefix for imported entries')
  .option('-f, --force', 'Overwrite existing entries')
  .action(async (source, file, options) => {
    try {
      const fs = await import('fs');
      const path = await import('path');

      const validSources: ImportSource[] = ['1password', 'bitwarden', 'lastpass', 'keepass', 'csv'];
      if (!validSources.includes(source as ImportSource)) {
        console.error(chalk.red(`Invalid source. Valid sources: ${validSources.join(', ')}`));
        process.exit(1);
      }

      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const gopass = getGopass();
      const store = gopass.rootStore;

      console.log(chalk.cyan(`Importing from ${source}...`));

      const result = await importPasswords(store, source as ImportSource, content, {
        prefix: options.prefix,
        overwrite: options.force,
      });

      console.log(chalk.green(`\nImport complete!`));
      console.log(`  Total entries: ${result.total}`);
      console.log(`  Imported: ${chalk.green(result.imported.toString())}`);
      console.log(`  Skipped: ${chalk.yellow(result.skipped.toString())}`);

      if (result.errors.length > 0) {
        console.log(chalk.red(`  Errors: ${result.errors.length}`));
        for (const err of result.errors.slice(0, 5)) {
          console.log(chalk.red(`    ${err}`));
        }
        if (result.errors.length > 5) {
          console.log(chalk.red(`    ... and ${result.errors.length - 5} more`));
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

// Export command
program
  .command('export <format> [output]')
  .description('Export passwords to a file')
  .option('-p, --prefix <prefix>', 'Only export entries with this prefix')
  .action(async (format, output, options) => {
    try {
      const validFormats: ExportFormat[] = ['passshare', 'bitwarden', 'csv'];
      if (!validFormats.includes(format as ExportFormat)) {
        console.error(chalk.red(`Invalid format. Valid formats: ${validFormats.join(', ')}`));
        process.exit(1);
      }

      const gopass = getGopass();

      console.log(chalk.cyan(`Exporting to ${format} format...`));

      const result = await exportPasswords(gopass, format as ExportFormat, {
        prefix: options.prefix,
      });

      if (output) {
        const fs = await import('fs');
        const path = await import('path');
        const outputPath = path.resolve(output);
        fs.writeFileSync(outputPath, result.content, 'utf-8');
        console.log(chalk.green(`\nExported to ${outputPath}`));
      } else {
        console.log(result.content);
      }

      console.log(chalk.green(`\nExport complete!`));
      console.log(`  Total entries: ${result.total}`);
      console.log(`  Exported: ${chalk.green(result.exported.toString())}`);

      if (result.errors.length > 0) {
        console.log(chalk.red(`  Errors: ${result.errors.length}`));
        for (const err of result.errors.slice(0, 5)) {
          console.log(chalk.red(`    ${err}`));
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

// Version command
program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`passshare ${VERSION}`);
    console.log('© 2026 株式会社BM1314. All rights reserved.');
  });

// Completion command
program
  .command('completion <shell>')
  .description('Generate shell completion script')
  .action((shell) => {
    switch (shell) {
      case 'bash':
        console.log(`
# PassShare bash completion
_passshare_completions() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local commands="show init insert edit delete generate list find grep copy move sync config mounts recipients otp audit pwgen history scan version"
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
}
complete -F _passshare_completions passshare
`);
        break;
      case 'zsh':
        console.log(`
#compdef passshare
_passshare() {
    local -a commands
    commands=(
        'show:Show a secret'
        'init:Initialize a new password store'
        'insert:Insert a new secret'
        'edit:Edit a secret'
        'delete:Delete a secret'
        'generate:Generate a password'
        'list:List secrets'
        'find:Find secrets by name'
        'grep:Search secret contents'
        'copy:Copy a secret'
        'move:Move a secret'
        'sync:Sync with remote'
        'config:Manage configuration'
        'mounts:Manage mount points'
        'recipients:Manage recipients'
        'otp:Generate OTP code'
        'audit:Audit password strength'
        'pwgen:Generate standalone passwords'
        'history:Show secret history'
        'scan:Scan directory for credentials'
        'version:Show version'
    )
    _describe 'command' commands
}
compdef _passshare passshare
`);
        break;
      case 'fish':
        console.log(`
# PassShare fish completion
complete -c passshare -n "__fish_use_subcommand" -a "show" -d "Show a secret"
complete -c passshare -n "__fish_use_subcommand" -a "init" -d "Initialize a new password store"
complete -c passshare -n "__fish_use_subcommand" -a "insert" -d "Insert a new secret"
complete -c passshare -n "__fish_use_subcommand" -a "edit" -d "Edit a secret"
complete -c passshare -n "__fish_use_subcommand" -a "delete" -d "Delete a secret"
complete -c passshare -n "__fish_use_subcommand" -a "generate" -d "Generate a password"
complete -c passshare -n "__fish_use_subcommand" -a "list" -d "List secrets"
complete -c passshare -n "__fish_use_subcommand" -a "find" -d "Find secrets by name"
complete -c passshare -n "__fish_use_subcommand" -a "grep" -d "Search secret contents"
complete -c passshare -n "__fish_use_subcommand" -a "copy" -d "Copy a secret"
complete -c passshare -n "__fish_use_subcommand" -a "move" -d "Move a secret"
complete -c passshare -n "__fish_use_subcommand" -a "sync" -d "Sync with remote"
complete -c passshare -n "__fish_use_subcommand" -a "config" -d "Manage configuration"
complete -c passshare -n "__fish_use_subcommand" -a "mounts" -d "Manage mount points"
complete -c passshare -n "__fish_use_subcommand" -a "recipients" -d "Manage recipients"
complete -c passshare -n "__fish_use_subcommand" -a "otp" -d "Generate OTP code"
complete -c passshare -n "__fish_use_subcommand" -a "audit" -d "Audit password strength"
complete -c passshare -n "__fish_use_subcommand" -a "pwgen" -d "Generate standalone passwords"
complete -c passshare -n "__fish_use_subcommand" -a "history" -d "Show secret history"
complete -c passshare -n "__fish_use_subcommand" -a "scan" -d "Scan directory for credentials"
complete -c passshare -n "__fish_use_subcommand" -a "version" -d "Show version"
`);
        break;
      case 'powershell':
        console.log(`
# PassShare PowerShell completion
Register-ArgumentCompleter -Native -CommandName passshare -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $commands = @(
        'show', 'init', 'insert', 'edit', 'delete', 'generate', 'list',
        'find', 'grep', 'copy', 'move', 'sync', 'config', 'mounts',
        'recipients', 'otp', 'audit', 'pwgen', 'history', 'scan', 'version'
    )
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`);
        break;
      default:
        console.error(chalk.red(`Unknown shell: ${shell}`));
        console.log('Supported shells: bash, zsh, fish, powershell');
        process.exit(1);
    }
  });

// Create command (interactive)
program
  .command('create')
  .description('Interactively create a new secret')
  .option('-s, --store <name>', 'Store name')
  .action(async (options) => {
    try {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      console.log(chalk.cyan('🧪 Creating a new secret...\n'));

      // Get name
      const name = await question('Secret name (e.g., email/gmail): ');
      if (!name.trim()) {
        console.error(chalk.red('Name is required'));
        rl.close();
        process.exit(1);
      }

      const gopass = getGopass();

      // Check if exists
      if (await gopass.exists(name)) {
        const overwrite = await question(chalk.yellow(`${name} already exists. Overwrite? [y/N]: `));
        if (overwrite.toLowerCase() !== 'y') {
          console.log('Cancelled');
          rl.close();
          return;
        }
      }

      // Generate or enter password
      const genPassword = await question('Generate password? [Y/n]: ');
      let password: string;

      if (genPassword.toLowerCase() !== 'n') {
        const lengthStr = await question('Password length [24]: ');
        const length = parseInt(lengthStr) || 24;
        password = generatePassword({ length, symbols: true });
        console.log(chalk.green(`Generated: ${password}`));
      } else {
        password = await question('Enter password: ');
      }

      // Additional fields
      const secret = new Secret(password);

      const username = await question('Username (optional): ');
      if (username) secret.set('username', username);

      const url = await question('URL (optional): ');
      if (url) secret.set('url', url);

      const notes = await question('Notes (optional): ');
      if (notes) secret.body = notes;

      rl.close();

      // Save
      await gopass.set(name, secret);
      console.log(chalk.green(`\n✅ Saved ${name}`));
    } catch (error) {
      handleError(error);
    }
  });

// Cat command
program
  .command('cat <name>')
  .description('Output secret to stdout (no parsing)')
  .action(async (name) => {
    try {
      const gopass = getGopass();
      const secret = await gopass.get(name);
      process.stdout.write(secret.toString());
    } catch (error) {
      handleError(error);
    }
  });

// Env command
program
  .command('env <name> [command...]')
  .description('Run command with secret as environment variables')
  .action(async (name, command) => {
    try {
      if (!command.length) {
        console.error(chalk.red('Usage: passshare env <name> -- <command...>'));
        process.exit(2);
      }

      const gopass = getGopass();
      const secret = await gopass.get(name);

      // Build environment
      const env: Record<string, string> = { ...process.env };

      // Add password
      env['PASSWORD'] = secret.password;

      // Add all key-value pairs
      for (const [key, value] of secret.data) {
        const envKey = key.toUpperCase().replace(/-/g, '_');
        env[envKey] = value;
      }

      // Execute command
      const { spawn } = await import('child_process');
      const [cmd, ...args] = command;

      const child = spawn(cmd, args, {
        env,
        stdio: 'inherit',
        shell: true,
      });

      child.on('close', (code) => {
        process.exit(code || 0);
      });
    } catch (error) {
      handleError(error);
    }
  });

// Helper function to print tree
function printTree(secrets: string[]): void {
  if (!secrets.length) {
    console.log('(empty)');
    return;
  }

  interface TreeNode {
    [key: string]: TreeNode;
  }

  const tree: TreeNode = {};
  for (const path of secrets) {
    const parts = path.split('/');
    let current = tree;
    for (const part of parts) {
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }
  }

  console.log('passshare');
  printTreeNode(tree, '');
}

function printTreeNode(node: { [key: string]: any }, prefix: string): void {
  const entries = Object.entries(node).sort(([a], [b]) => a.localeCompare(b));

  for (let i = 0; i < entries.length; i++) {
    const [name, children] = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (Object.keys(children).length > 0) {
      console.log(`${prefix}${connector}${chalk.blue(name)}/`);
      printTreeNode(children, prefix + childPrefix);
    } else {
      console.log(`${prefix}${connector}${name}`);
    }
  }
}

program.parse();
