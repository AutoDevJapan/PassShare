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
} from '@passshare/core';

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
  .description('Audit password strength')
  .action(async (folder) => {
    try {
      const gopass = getGopass();
      const secrets = await gopass.list(folder || '');

      console.log(`Auditing ${secrets.length} secrets...`);

      const weakPasswords: Array<{ name: string; strength: ReturnType<typeof checkPasswordStrength> }> = [];
      const duplicates: Map<string, string[]> = new Map();

      for (const name of secrets) {
        try {
          const secret = await gopass.get(name);
          const password = secret.password;
          const strength = checkPasswordStrength(password);

          if (strength.strength === 'weak' || strength.strength === 'fair') {
            weakPasswords.push({ name, strength });
          }

          if (!duplicates.has(password)) {
            duplicates.set(password, []);
          }
          duplicates.get(password)!.push(name);
        } catch {
          // Skip
        }
      }

      if (weakPasswords.length) {
        console.log(chalk.yellow('\nWeak passwords:'));
        for (const { name, strength } of weakPasswords) {
          console.log(`  ${name}: ${strength.strength} (entropy: ${strength.entropy.toFixed(1)})`);
        }
      }

      const dupGroups = Array.from(duplicates.values()).filter((names) => names.length > 1);
      if (dupGroups.length) {
        console.log(chalk.yellow('\nDuplicate passwords:'));
        for (const names of dupGroups) {
          console.log(`  ${names.join(', ')}`);
        }
      }

      if (!weakPasswords.length && !dupGroups.length) {
        console.log(chalk.green('All passwords look good!'));
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
