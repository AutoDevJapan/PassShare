"""Clipboard utilities for PassShare."""

import threading

_clipboard_timer: threading.Timer | None = None
_clipboard_lock = threading.Lock()


def copy_to_clipboard(
    text: str,
    timeout: int = 45,
    clear_previous: bool = True,
) -> None:
    """Copy text to clipboard with auto-clear.

    Args:
        text: The text to copy.
        timeout: Seconds before auto-clear (0 to disable).
        clear_previous: Cancel any previous clear timer.
    """
    global _clipboard_timer

    try:
        import pyperclip

        # Cancel existing timer
        if clear_previous:
            with _clipboard_lock:
                if _clipboard_timer is not None:
                    _clipboard_timer.cancel()
                    _clipboard_timer = None

        # Copy to clipboard
        pyperclip.copy(text)

        # Set up auto-clear
        if timeout > 0:
            with _clipboard_lock:
                _clipboard_timer = threading.Timer(timeout, _clear_clipboard_internal)
                _clipboard_timer.daemon = True
                _clipboard_timer.start()

    except ImportError:
        # pyperclip not available, try platform-specific
        _copy_native(text)

        if timeout > 0:
            with _clipboard_lock:
                _clipboard_timer = threading.Timer(timeout, _clear_clipboard_internal)
                _clipboard_timer.daemon = True
                _clipboard_timer.start()


def _clear_clipboard_internal() -> None:
    """Internal function to clear clipboard."""
    global _clipboard_timer

    with _clipboard_lock:
        _clipboard_timer = None

    clear_clipboard()


def clear_clipboard() -> None:
    """Clear the clipboard."""
    try:
        import pyperclip

        pyperclip.copy("")
    except ImportError:
        _copy_native("")


def _copy_native(text: str) -> None:
    """Copy using native platform tools.

    Args:
        text: The text to copy.
    """
    import subprocess
    import sys

    if sys.platform == "darwin":
        # macOS
        subprocess.run(
            ["pbcopy"],
            input=text.encode("utf-8"),
            check=False,
        )
    elif sys.platform == "win32":
        # Windows
        try:
            subprocess.run(
                ["clip"],
                input=text.encode("utf-16le"),
                check=False,
            )
        except FileNotFoundError:
            pass
    else:
        # Linux/BSD - try various clipboard tools
        for cmd in ["xclip", "xsel", "wl-copy"]:
            try:
                if cmd == "xclip":
                    subprocess.run(
                        ["xclip", "-selection", "clipboard"],
                        input=text.encode("utf-8"),
                        check=True,
                    )
                    return
                elif cmd == "xsel":
                    subprocess.run(
                        ["xsel", "--clipboard", "--input"],
                        input=text.encode("utf-8"),
                        check=True,
                    )
                    return
                elif cmd == "wl-copy":
                    subprocess.run(
                        ["wl-copy"],
                        input=text.encode("utf-8"),
                        check=True,
                    )
                    return
            except (FileNotFoundError, subprocess.CalledProcessError):
                continue


def get_clipboard() -> str:
    """Get clipboard contents.

    Returns:
        The clipboard text.
    """
    try:
        import pyperclip

        return pyperclip.paste()
    except ImportError:
        return _get_native()


def _get_native() -> str:
    """Get clipboard using native platform tools.

    Returns:
        The clipboard text.
    """
    import subprocess
    import sys

    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["pbpaste"],
                capture_output=True,
                check=True,
            )
            return result.stdout.decode("utf-8")
        elif sys.platform == "win32":
            result = subprocess.run(
                ["powershell", "-command", "Get-Clipboard"],
                capture_output=True,
                check=True,
            )
            return result.stdout.decode("utf-8").strip()
        else:
            # Try xclip first
            try:
                result = subprocess.run(
                    ["xclip", "-selection", "clipboard", "-o"],
                    capture_output=True,
                    check=True,
                )
                return result.stdout.decode("utf-8")
            except (FileNotFoundError, subprocess.CalledProcessError):
                pass

            # Try xsel
            try:
                result = subprocess.run(
                    ["xsel", "--clipboard", "--output"],
                    capture_output=True,
                    check=True,
                )
                return result.stdout.decode("utf-8")
            except (FileNotFoundError, subprocess.CalledProcessError):
                pass

            # Try wl-paste
            try:
                result = subprocess.run(
                    ["wl-paste"],
                    capture_output=True,
                    check=True,
                )
                return result.stdout.decode("utf-8")
            except (FileNotFoundError, subprocess.CalledProcessError):
                pass

    except Exception:
        pass

    return ""
