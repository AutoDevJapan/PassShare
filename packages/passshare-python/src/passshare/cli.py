"""PassShare CLI - Command Line Interface.

A gopass-compatible CLI for password management.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import click

from passshare import __version__
from passshare.clipboard import copy_to_clipboard
from passshare.errors import NotFoundError, PassShareError
from passshare.gopass import Gopass
from passshare.password import generate_password, check_password_strength
from passshare.secret import Secret


# Global options
pass_gopass = click.make_pass_decorator(Gopass, ensure=True)


def get_gopass() -> Gopass:
    """Get or create a Gopass instance."""
    return Gopass()


@click.group(invoke_without_command=True)
@click.option("--version", is_flag=True, help="Show version")
@click.pass_context
def main(ctx: click.Context, version: bool) -> None:
    """PassShare - A gopass-compatible password manager.

    \b
    Examples:
        passshare show email/gmail
        passshare insert email/work
        passshare generate social/twitter 24
        passshare list
    """
    if version:
        click.echo(f"passshare {__version__}")
        return

    # If no subcommand, show help or start REPL
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# =============================================================================
# Show command
# =============================================================================


@main.command("show")
@click.argument("name", required=False)
@click.argument("key", required=False)
@click.option("-c", "--clip", is_flag=True, help="Copy to clipboard")
@click.option("-C", "--alsoclip", is_flag=True, help="Print and copy to clipboard")
@click.option("-o", "--password", is_flag=True, help="Show password only")
@click.option("-n", "--noparsing", is_flag=True, help="Show raw content")
@click.option("-r", "--revision", help="Show specific revision")
def show(
    name: Optional[str],
    key: Optional[str],
    clip: bool,
    alsoclip: bool,
    password: bool,
    noparsing: bool,
    revision: Optional[str],
) -> None:
    """Show a secret.

    \b
    Examples:
        passshare show email/gmail
        passshare show email/gmail username
        passshare show -c email/gmail
    """
    if not name:
        # List mode if no name given
        ctx = click.get_current_context()
        ctx.invoke(list_cmd)
        return

    try:
        gopass = get_gopass()

        if revision:
            secret = gopass.show_revision(name, revision)
        else:
            secret = gopass.get(name)

        # Determine what to output
        if key:
            output = secret.get(key)
        elif password:
            output = secret.password
        elif noparsing:
            output = str(secret)
        else:
            output = str(secret)

        # Handle clipboard
        if clip or alsoclip:
            copy_text = secret.password if not key else output
            copy_to_clipboard(copy_text)
            if clip and not alsoclip:
                click.echo(f"Copied {name} to clipboard. Will clear in 45 seconds.")
                return

        click.echo(output)

    except NotFoundError:
        click.echo(f"Error: Secret not found: {name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# Add 'show' as default command alias
main.add_command(show, name="")


# =============================================================================
# Init command
# =============================================================================


@main.command("init")
@click.argument("gpg_ids", nargs=-1, required=True)
@click.option("-s", "--store", help="Store name (for mounts)")
@click.option("-p", "--path", help="Store path")
@click.option("--crypto", default="gpg", help="Crypto backend (gpg, age)")
@click.option("--storage", default="gitfs", help="Storage backend (gitfs, fs)")
def init_cmd(
    gpg_ids: tuple[str, ...],
    store: Optional[str],
    path: Optional[str],
    crypto: str,
    storage: str,
) -> None:
    """Initialize a new password store.

    \b
    Examples:
        passshare init 0xDEADBEEF
        passshare init --store work 0xFEEDBEEF
    """
    try:
        gopass = get_gopass()
        store_path = Path(path) if path else None

        gopass.init(
            recipients=list(gpg_ids),
            path=store_path,
            crypto=crypto,
            storage=storage,
        )

        click.echo(f"Password store initialized at {store_path or gopass.config.store_path}")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Insert command
# =============================================================================


@main.command("insert")
@click.argument("name")
@click.option("-e", "--echo", is_flag=True, help="Echo input")
@click.option("-m", "--multiline", is_flag=True, help="Multiline input")
@click.option("-f", "--force", is_flag=True, help="Overwrite existing")
@click.option("-a", "--append", is_flag=True, help="Append to existing")
def insert(name: str, echo: bool, multiline: bool, force: bool, append: bool) -> None:
    """Insert a new secret.

    \b
    Examples:
        passshare insert email/gmail
        passshare insert -m email/gmail
        echo "password" | passshare insert email/gmail
    """
    try:
        gopass = get_gopass()

        # Check if exists
        if gopass.exists(name) and not force and not append:
            if not click.confirm(f"Secret {name} already exists. Overwrite?"):
                return

        # Get input
        if not sys.stdin.isatty():
            # Reading from pipe
            content = sys.stdin.read()
        elif multiline:
            click.echo("Enter secret (Ctrl+D to finish):")
            content = sys.stdin.read()
        else:
            if echo:
                content = click.prompt("Enter secret")
            else:
                content = click.prompt("Enter secret", hide_input=True)
                confirm = click.prompt("Confirm secret", hide_input=True)
                if content != confirm:
                    click.echo("Error: Secrets do not match", err=True)
                    sys.exit(1)

        # Handle append
        if append and gopass.exists(name):
            existing = gopass.get(name)
            content = str(existing) + "\n" + content

        # Parse and save
        secret = Secret.parse(content)
        gopass.set(name, secret)

        click.echo(f"Saved {name}")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Edit command
# =============================================================================


@main.command("edit")
@click.argument("name")
@click.option("-e", "--editor", help="Editor to use")
@click.option("-c", "--create", is_flag=True, help="Create if not exists")
def edit(name: str, editor: Optional[str], create: bool) -> None:
    """Edit a secret.

    \b
    Examples:
        passshare edit email/gmail
    """
    import os
    import tempfile

    try:
        gopass = get_gopass()

        # Get existing content
        if gopass.exists(name):
            secret = gopass.get(name)
            content = str(secret)
        elif create:
            content = ""
        else:
            raise NotFoundError(name)

        # Determine editor
        ed = editor or os.environ.get("EDITOR", "vim")

        # Create temp file
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            delete=False,
        ) as f:
            f.write(content)
            temp_path = f.name

        try:
            # Open editor
            import subprocess

            subprocess.run([ed, temp_path], check=True)

            # Read back
            with open(temp_path, "r") as f:
                new_content = f.read()

            # Save
            new_secret = Secret.parse(new_content)
            gopass.set(name, new_secret)
            click.echo(f"Saved {name}")

        finally:
            # Clean up temp file
            os.unlink(temp_path)

    except NotFoundError:
        click.echo(f"Error: Secret not found: {name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Delete command
# =============================================================================


@main.command("delete")
@click.argument("name")
@click.option("-f", "--force", is_flag=True, help="Skip confirmation")
@click.option("-r", "--recursive", is_flag=True, help="Delete recursively")
def delete(name: str, force: bool, recursive: bool) -> None:
    """Delete a secret.

    \b
    Examples:
        passshare delete email/old
        passshare delete -r email/
    """
    try:
        gopass = get_gopass()

        if recursive:
            # Delete all matching secrets
            secrets = [s for s in gopass.list() if s.startswith(name)]
            if not secrets:
                raise NotFoundError(name)

            if not force:
                click.echo(f"Will delete {len(secrets)} secrets:")
                for s in secrets[:10]:
                    click.echo(f"  {s}")
                if len(secrets) > 10:
                    click.echo(f"  ... and {len(secrets) - 10} more")
                if not click.confirm("Continue?"):
                    return

            for s in secrets:
                gopass.delete(s)
                click.echo(f"Deleted {s}")
        else:
            if not force:
                if not click.confirm(f"Delete {name}?"):
                    return

            gopass.delete(name)
            click.echo(f"Deleted {name}")

    except NotFoundError:
        click.echo(f"Error: Secret not found: {name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# Alias for delete
main.add_command(delete, name="rm")


# =============================================================================
# Generate command
# =============================================================================


@main.command("generate")
@click.argument("name")
@click.argument("length", default=24, type=int)
@click.option("-c", "--clip", is_flag=True, help="Copy to clipboard")
@click.option("-p", "--print", "print_", is_flag=True, help="Print password")
@click.option("-f", "--force", is_flag=True, help="Overwrite existing")
@click.option("-n", "--no-symbols", is_flag=True, help="No symbols")
@click.option("-s", "--symbols", is_flag=True, help="Include symbols")
@click.option("-x", "--xkcd", is_flag=True, help="XKCD-style password")
@click.option("--sep", default="-", help="XKCD separator")
def generate_cmd(
    name: str,
    length: int,
    clip: bool,
    print_: bool,
    force: bool,
    no_symbols: bool,
    symbols: bool,
    xkcd: bool,
    sep: str,
) -> None:
    """Generate a password.

    \b
    Examples:
        passshare generate email/new 24
        passshare generate -x email/new
        passshare generate -n email/new 16
    """
    try:
        gopass = get_gopass()

        # Check if exists
        if gopass.exists(name) and not force:
            if not click.confirm(f"Secret {name} already exists. Overwrite?"):
                return

        # Generate
        use_symbols = symbols or not no_symbols
        password = gopass.generate(
            name,
            length=length,
            symbols=use_symbols,
            xkcd=xkcd,
            force=True,
        )

        # Output
        if clip:
            copy_to_clipboard(password)
            click.echo(f"Generated password for {name}. Copied to clipboard.")
        elif print_ or not clip:
            click.echo(f"Generated password for {name}: {password}")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# List command
# =============================================================================


@main.command("list")
@click.argument("folder", required=False)
@click.option("-l", "--limit", type=int, help="Limit results")
@click.option("-f", "--flat", is_flag=True, help="Flat list")
@click.option("-s", "--strip-prefix", is_flag=True, help="Strip prefix")
def list_cmd(
    folder: Optional[str],
    limit: Optional[int],
    flat: bool,
    strip_prefix: bool,
) -> None:
    """List secrets.

    \b
    Examples:
        passshare list
        passshare list email/
        passshare ls
    """
    try:
        gopass = get_gopass()
        secrets = gopass.list(folder or "")

        if limit:
            secrets = secrets[:limit]

        if strip_prefix and folder:
            prefix = folder.rstrip("/") + "/"
            secrets = [s[len(prefix):] if s.startswith(prefix) else s for s in secrets]

        if flat:
            for s in secrets:
                click.echo(s)
        else:
            # Tree format
            _print_tree(secrets)

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


def _print_tree(secrets: list[str]) -> None:
    """Print secrets in tree format."""
    if not secrets:
        click.echo("(empty)")
        return

    # Build tree structure
    tree: dict = {}
    for path in secrets:
        parts = path.split("/")
        current = tree
        for part in parts:
            if part not in current:
                current[part] = {}
            current = current[part]

    # Print tree
    click.echo("passshare")
    _print_tree_node(tree, "")


def _print_tree_node(node: dict, prefix: str) -> None:
    """Print a tree node recursively."""
    items = sorted(node.items())
    for i, (name, children) in enumerate(items):
        is_last = i == len(items) - 1
        connector = "└── " if is_last else "├── "
        child_prefix = "    " if is_last else "│   "

        if children:
            click.echo(f"{prefix}{connector}{name}/")
            _print_tree_node(children, prefix + child_prefix)
        else:
            click.echo(f"{prefix}{connector}{name}")


# Alias for list
main.add_command(list_cmd, name="ls")


# =============================================================================
# Find command
# =============================================================================


@main.command("find")
@click.argument("pattern")
@click.option("-c", "--clip", is_flag=True, help="Copy first result to clipboard")
def find_cmd(pattern: str, clip: bool) -> None:
    """Find secrets by name.

    \b
    Examples:
        passshare find gmail
        passshare search github
    """
    try:
        gopass = get_gopass()
        matches = gopass.find(pattern)

        if not matches:
            click.echo(f"No matches found for: {pattern}")
            return

        for match in matches:
            click.echo(match)

        if clip and matches:
            secret = gopass.get(matches[0])
            copy_to_clipboard(secret.password)
            click.echo(f"\nCopied {matches[0]} to clipboard.")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


main.add_command(find_cmd, name="search")


# =============================================================================
# Grep command
# =============================================================================


@main.command("grep")
@click.argument("pattern")
@click.option("-n", "--name", is_flag=True, help="Also search names")
def grep_cmd(pattern: str, name: bool) -> None:
    """Search secret contents.

    \b
    Examples:
        passshare grep "api.example.com"
    """
    try:
        gopass = get_gopass()
        results = gopass.grep(pattern)

        for secret_name, line in results:
            click.echo(f"{secret_name}: {line}")

        if not results:
            click.echo(f"No matches found for: {pattern}")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Copy command
# =============================================================================


@main.command("copy")
@click.argument("from_name")
@click.argument("to_name")
@click.option("-f", "--force", is_flag=True, help="Overwrite existing")
def copy_cmd(from_name: str, to_name: str, force: bool) -> None:
    """Copy a secret.

    \b
    Examples:
        passshare copy email/old email/new
        passshare cp email/old email/backup
    """
    try:
        gopass = get_gopass()
        gopass.copy(from_name, to_name, force)
        click.echo(f"Copied {from_name} to {to_name}")

    except NotFoundError:
        click.echo(f"Error: Secret not found: {from_name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


main.add_command(copy_cmd, name="cp")


# =============================================================================
# Move command
# =============================================================================


@main.command("move")
@click.argument("from_name")
@click.argument("to_name")
@click.option("-f", "--force", is_flag=True, help="Overwrite existing")
def move_cmd(from_name: str, to_name: str, force: bool) -> None:
    """Move a secret.

    \b
    Examples:
        passshare move email/old email/new
        passshare mv email/old archive/email/old
    """
    try:
        gopass = get_gopass()
        gopass.move(from_name, to_name, force)
        click.echo(f"Moved {from_name} to {to_name}")

    except NotFoundError:
        click.echo(f"Error: Secret not found: {from_name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


main.add_command(move_cmd, name="mv")


# =============================================================================
# Sync command
# =============================================================================


@main.command("sync")
@click.option("-s", "--store", help="Store to sync")
def sync_cmd(store: Optional[str]) -> None:
    """Sync with remote.

    \b
    Examples:
        passshare sync
        passshare sync -s work
    """
    try:
        gopass = get_gopass()
        gopass.sync(store)
        click.echo("Sync complete")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Config command
# =============================================================================


@main.command("config")
@click.argument("key", required=False)
@click.argument("value", required=False)
@click.option("-s", "--store", help="Store-specific config")
def config_cmd(key: Optional[str], value: Optional[str], store: Optional[str]) -> None:
    """Manage configuration.

    \b
    Examples:
        passshare config
        passshare config autoclip
        passshare config autoclip true
    """
    try:
        gopass = get_gopass()
        config = gopass.config

        if not key:
            # Show all config
            click.echo(f"path: {config.store_path}")
            for k in ["autoclip", "cliptimeout", "autosync", "autopush"]:
                click.echo(f"{k}: {config.get(k)}")
            if config.mounts:
                click.echo("mounts:")
                for alias, path in config.mounts.items():
                    click.echo(f"  {alias}: {path}")
        elif not value:
            # Show single config
            click.echo(f"{key}: {config.get(key)}")
        else:
            # Set config
            if value.lower() in ("true", "yes", "1"):
                config.set(key, True)
            elif value.lower() in ("false", "no", "0"):
                config.set(key, False)
            elif value.isdigit():
                config.set(key, int(value))
            else:
                config.set(key, value)
            config.save()
            click.echo(f"Set {key} = {value}")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Mounts command
# =============================================================================


@main.command("mounts")
@click.argument("action", required=False)
@click.argument("args", nargs=-1)
def mounts_cmd(action: Optional[str], args: tuple[str, ...]) -> None:
    """Manage mount points.

    \b
    Examples:
        passshare mounts
        passshare mounts add work ~/.local/share/gopass/stores/work
        passshare mounts remove work
    """
    try:
        gopass = get_gopass()

        if not action:
            # List mounts
            if not gopass.mounts:
                click.echo("No mounts configured")
            else:
                for alias, path in gopass.mounts.items():
                    click.echo(f"{alias}: {path}")
        elif action == "add":
            if len(args) != 2:
                click.echo("Usage: passshare mounts add <alias> <path>", err=True)
                sys.exit(2)
            gopass.mount(args[0], args[1])
            click.echo(f"Added mount {args[0]} -> {args[1]}")
        elif action == "remove":
            if len(args) != 1:
                click.echo("Usage: passshare mounts remove <alias>", err=True)
                sys.exit(2)
            gopass.unmount(args[0])
            click.echo(f"Removed mount {args[0]}")
        else:
            click.echo(f"Unknown action: {action}", err=True)
            sys.exit(2)

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Recipients command
# =============================================================================


@main.command("recipients")
@click.argument("action", required=False)
@click.argument("key_id", required=False)
@click.option("-s", "--store", help="Store name")
def recipients_cmd(
    action: Optional[str],
    key_id: Optional[str],
    store: Optional[str],
) -> None:
    """Manage recipients.

    \b
    Examples:
        passshare recipients
        passshare recipients add 0xDEADBEEF
        passshare recipients remove 0xDEADBEEF
    """
    try:
        gopass = get_gopass()

        if not action:
            # List recipients
            recipients = gopass.recipients(store)
            if not recipients:
                click.echo("No recipients configured")
            else:
                for r in recipients:
                    click.echo(r)
        elif action == "add":
            if not key_id:
                click.echo("Usage: passshare recipients add <key_id>", err=True)
                sys.exit(2)
            gopass.add_recipient(key_id, store)
            click.echo(f"Added recipient {key_id}")
        elif action == "remove":
            if not key_id:
                click.echo("Usage: passshare recipients remove <key_id>", err=True)
                sys.exit(2)
            gopass.remove_recipient(key_id, store)
            click.echo(f"Removed recipient {key_id}")
        elif action == "show":
            recipients = gopass.recipients(store)
            for r in recipients:
                click.echo(r)
        else:
            click.echo(f"Unknown action: {action}", err=True)
            sys.exit(2)

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# OTP command
# =============================================================================


@main.command("otp")
@click.argument("name")
@click.option("-c", "--clip", is_flag=True, help="Copy to clipboard")
@click.option("-q", "--qr", is_flag=True, help="Show QR code")
def otp_cmd(name: str, clip: bool, qr: bool) -> None:
    """Generate OTP code.

    \b
    Examples:
        passshare otp email/gmail
        passshare otp -c email/gmail
    """
    try:
        gopass = get_gopass()
        secret = gopass.get(name)

        otp_code = secret.otp()
        if not otp_code:
            click.echo(f"No OTP configured for {name}", err=True)
            sys.exit(1)

        if clip:
            copy_to_clipboard(otp_code)
            click.echo(f"Copied OTP to clipboard: {otp_code}")
        else:
            click.echo(otp_code)

    except NotFoundError:
        click.echo(f"Error: Secret not found: {name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Audit command
# =============================================================================


@main.command("audit")
@click.argument("folder", required=False)
@click.option("--full", is_flag=True, help="Full audit")
@click.option("--hibp", is_flag=True, help="Check Have I Been Pwned")
def audit_cmd(folder: Optional[str], full: bool, hibp: bool) -> None:
    """Audit password strength.

    \b
    Examples:
        passshare audit
        passshare audit --hibp
    """
    try:
        gopass = get_gopass()
        secrets = gopass.list(folder or "")

        weak_passwords = []
        duplicates: dict[str, list[str]] = {}

        click.echo(f"Auditing {len(secrets)} secrets...")

        for name in secrets:
            try:
                secret = gopass.get(name)
                password = secret.password

                # Check strength
                strength = check_password_strength(password)
                if strength["strength"] in ("weak", "fair"):
                    weak_passwords.append((name, strength))

                # Track duplicates
                if password not in duplicates:
                    duplicates[password] = []
                duplicates[password].append(name)

            except Exception:
                pass

        # Report weak passwords
        if weak_passwords:
            click.echo("\nWeak passwords:")
            for name, strength in weak_passwords:
                click.echo(f"  {name}: {strength['strength']} (entropy: {strength['entropy']:.1f})")

        # Report duplicates
        dup_groups = [names for names in duplicates.values() if len(names) > 1]
        if dup_groups:
            click.echo("\nDuplicate passwords:")
            for names in dup_groups:
                click.echo(f"  {', '.join(names)}")

        if not weak_passwords and not dup_groups:
            click.echo("All passwords look good!")

    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Pwgen command
# =============================================================================


@main.command("pwgen")
@click.argument("length", default=24, type=int)
@click.option("-n", "--no-symbols", is_flag=True, help="No symbols")
@click.option("-s", "--symbols", is_flag=True, help="Include symbols")
@click.option("-x", "--xkcd", is_flag=True, help="XKCD-style")
@click.option("--one-per-line", is_flag=True, help="One password per line")
@click.option("--count", default=1, type=int, help="Number of passwords")
def pwgen_cmd(
    length: int,
    no_symbols: bool,
    symbols: bool,
    xkcd: bool,
    one_per_line: bool,
    count: int,
) -> None:
    """Generate standalone passwords.

    \b
    Examples:
        passshare pwgen
        passshare pwgen 32
        passshare pwgen -x
    """
    use_symbols = symbols or not no_symbols

    passwords = []
    for _ in range(count):
        pw = generate_password(
            length=length,
            symbols=use_symbols,
            xkcd=xkcd,
        )
        passwords.append(pw)

    if one_per_line:
        for pw in passwords:
            click.echo(pw)
    else:
        click.echo(" ".join(passwords))


# =============================================================================
# History command
# =============================================================================


@main.command("history")
@click.argument("name")
@click.option("-p", "--password", is_flag=True, help="Show password history")
def history_cmd(name: str, password: bool) -> None:
    """Show secret history.

    \b
    Examples:
        passshare history email/gmail
    """
    try:
        gopass = get_gopass()
        history = gopass.history(name)

        if not history:
            click.echo(f"No history available for {name}")
            return

        click.echo(f"History for {name}:")
        for entry in history:
            click.echo(f"  * {entry['date']} - {entry['message']}")

    except NotFoundError:
        click.echo(f"Error: Secret not found: {name}", err=True)
        sys.exit(10)
    except PassShareError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# Completion command
# =============================================================================


@main.command("completion")
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish", "powershell"]))
def completion_cmd(shell: str) -> None:
    """Generate shell completion script.

    \b
    Examples:
        passshare completion bash
        passshare completion zsh >> ~/.zshrc
    """
    import os

    if shell == "bash":
        os.system("_PASSSHARE_COMPLETE=bash_source passshare")
    elif shell == "zsh":
        os.system("_PASSSHARE_COMPLETE=zsh_source passshare")
    elif shell == "fish":
        os.system("_PASSSHARE_COMPLETE=fish_source passshare")
    elif shell == "powershell":
        click.echo("# PowerShell completion not yet implemented")


# =============================================================================
# Version command
# =============================================================================


@main.command("version")
def version_cmd() -> None:
    """Show version information."""
    click.echo(f"passshare {__version__}")
    click.echo("© 2026 株式会社BM1314. All rights reserved.")


if __name__ == "__main__":
    main()
