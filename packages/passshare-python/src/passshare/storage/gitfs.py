"""Git + Filesystem storage backend."""

import re
import subprocess
from pathlib import Path

from passshare.errors import GitError, NotFoundError, StorageError
from passshare.storage.fs import FSBackend


class GitFSBackend(FSBackend):
    """Git + Filesystem storage backend with version control."""

    def __init__(
        self,
        path: Path,
        extension: str = ".gpg",
        git_binary: str | None = None,
    ) -> None:
        """Initialize the GitFS backend.

        Args:
            path: The store root path.
            extension: File extension for secrets.
            git_binary: Path to git binary.
        """
        super().__init__(path, extension)
        self._git = git_binary or "git"

    def _run_git(
        self,
        args: list[str],
        check: bool = True,
        capture_output: bool = True,
    ) -> subprocess.CompletedProcess[bytes]:
        """Run a git command.

        Args:
            args: Command arguments.
            check: Whether to check return code.
            capture_output: Whether to capture output.

        Returns:
            The completed process.

        Raises:
            GitError: If the command fails.
        """
        cmd = [self._git, "-C", str(self._path)] + args

        try:
            result = subprocess.run(
                cmd,
                capture_output=capture_output,
                check=check,
            )
            return result
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
            raise GitError(f"Git command failed: {stderr}", " ".join(args)) from e
        except FileNotFoundError as e:
            raise GitError(f"Git binary not found: {self._git}") from e

    def init(self, path: Path) -> None:
        """Initialize a new store with git.

        Args:
            path: The store path.

        Raises:
            StorageError: If initialization fails.
        """
        # First initialize the filesystem
        super().init(path)

        # Then initialize git
        try:
            self._run_git(["init"])

            # Create .gitattributes
            gitattributes = path / ".gitattributes"
            gitattributes.write_text(f"*{self._extension} diff=gpg\n")

            # Add and commit
            self._run_git(["add", ".gitattributes"])
            self._run_git(
                ["commit", "-m", "Initialize password store"],
                check=False,  # May fail if no user configured
            )
        except GitError as e:
            raise StorageError(f"Failed to initialize git: {e}", str(path)) from e

    def initialized(self) -> bool:
        """Check if the store is initialized with git.

        Returns:
            True if the store is a git repository.
        """
        if not super().initialized():
            return False

        git_dir = self._path / ".git"
        return git_dir.exists() and git_dir.is_dir()

    def set(self, name: str, value: bytes) -> None:
        """Set a secret's content and commit.

        Args:
            name: The secret name/path.
            value: The encrypted content.

        Raises:
            StorageError: If writing fails.
        """
        is_new = not self.exists(name)
        super().set(name, value)

        # Git add and commit
        try:
            file_path = self._resolve_path(name)
            rel_path = file_path.relative_to(self._path)

            self._run_git(["add", str(rel_path)])

            action = "Add" if is_new else "Edit"
            self._run_git(
                ["commit", "-m", f"{action} secret for {name}"],
                check=False,
            )
        except GitError:
            # Don't fail if git operations fail
            pass

    def delete(self, name: str) -> None:
        """Delete a secret and commit.

        Args:
            name: The secret name/path.

        Raises:
            NotFoundError: If the secret doesn't exist.
            StorageError: If deletion fails.
        """
        file_path = self._resolve_path(name)

        if not file_path.exists():
            raise NotFoundError(name)

        try:
            rel_path = file_path.relative_to(self._path)
            self._run_git(["rm", "-f", str(rel_path)])
            self._run_git(
                ["commit", "-m", f"Remove secret for {name}"],
                check=False,
            )
        except GitError:
            # Fall back to direct deletion
            super().delete(name)

    def add(self, files: list[str]) -> None:
        """Add files to git index.

        Args:
            files: List of file paths.
        """
        if not files:
            return

        try:
            self._run_git(["add"] + files)
        except GitError:
            pass

    def commit(self, message: str) -> None:
        """Create a git commit.

        Args:
            message: The commit message.

        Raises:
            GitError: If the commit fails.
        """
        self._run_git(["commit", "-m", message], check=False)

    def push(self, remote: str = "origin", branch: str = "master") -> None:
        """Push to remote.

        Args:
            remote: The remote name.
            branch: The branch name.

        Raises:
            GitError: If push fails.
        """
        self._run_git(["push", remote, branch])

    def pull(self, remote: str = "origin", branch: str = "master") -> None:
        """Pull from remote with rebase.

        Args:
            remote: The remote name.
            branch: The branch name.

        Raises:
            GitError: If pull fails.
        """
        self._run_git(["pull", "--rebase", remote, branch])

    def sync(self, remote: str = "origin", branch: str = "master") -> None:
        """Sync with remote (pull then push).

        Args:
            remote: The remote name.
            branch: The branch name.

        Raises:
            GitError: If sync fails.
        """
        self.pull(remote, branch)
        self.push(remote, branch)

    def clone(self, url: str, path: Path) -> None:
        """Clone a remote repository.

        Args:
            url: The repository URL.
            path: The destination path.

        Raises:
            GitError: If clone fails.
        """
        try:
            subprocess.run(
                [self._git, "clone", url, str(path)],
                capture_output=True,
                check=True,
            )
            self._path = path
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
            raise GitError(f"Clone failed: {stderr}", f"clone {url}") from e

    def status(self) -> str:
        """Get git status.

        Returns:
            The status output.
        """
        try:
            result = self._run_git(["status", "--porcelain"])
            return result.stdout.decode("utf-8", errors="replace")
        except GitError:
            return ""

    def log(self, count: int = 10) -> list[dict[str, str]]:
        """Get git log.

        Args:
            count: Number of commits to return.

        Returns:
            List of commit dicts with hash, message, date, author.
        """
        try:
            result = self._run_git([
                "log",
                f"-{count}",
                "--format=%H|%s|%ai|%an",
            ])
            output = result.stdout.decode("utf-8", errors="replace")

            commits = []
            for line in output.strip().split("\n"):
                if "|" in line:
                    parts = line.split("|", 3)
                    if len(parts) == 4:
                        commits.append({
                            "hash": parts[0],
                            "message": parts[1],
                            "date": parts[2],
                            "author": parts[3],
                        })

            return commits
        except GitError:
            return []

    def history(self, name: str, count: int = 10) -> list[dict[str, str]]:
        """Get history for a specific secret.

        Args:
            name: The secret name.
            count: Number of commits to return.

        Returns:
            List of commit dicts.
        """
        file_path = self._resolve_path(name)
        rel_path = file_path.relative_to(self._path)

        try:
            result = self._run_git([
                "log",
                f"-{count}",
                "--format=%H|%s|%ai|%an",
                "--follow",
                "--",
                str(rel_path),
            ])
            output = result.stdout.decode("utf-8", errors="replace")

            commits = []
            for line in output.strip().split("\n"):
                if "|" in line:
                    parts = line.split("|", 3)
                    if len(parts) == 4:
                        commits.append({
                            "hash": parts[0],
                            "message": parts[1],
                            "date": parts[2],
                            "author": parts[3],
                        })

            return commits
        except GitError:
            return []

    def show_revision(self, name: str, revision: str) -> bytes:
        """Get a specific revision of a secret.

        Args:
            name: The secret name.
            revision: The git revision (commit hash).

        Returns:
            The content at that revision.

        Raises:
            NotFoundError: If the revision doesn't exist.
        """
        file_path = self._resolve_path(name)
        rel_path = file_path.relative_to(self._path)

        try:
            result = self._run_git(["show", f"{revision}:{rel_path}"])
            return result.stdout
        except GitError as e:
            raise NotFoundError(f"{name}@{revision}") from e

    def add_remote(self, name: str, url: str) -> None:
        """Add a git remote.

        Args:
            name: The remote name.
            url: The remote URL.
        """
        try:
            self._run_git(["remote", "add", name, url], check=False)
        except GitError:
            pass

    def remove_remote(self, name: str) -> None:
        """Remove a git remote.

        Args:
            name: The remote name.
        """
        try:
            self._run_git(["remote", "remove", name], check=False)
        except GitError:
            pass

    def list_remotes(self) -> list[str]:
        """List git remotes.

        Returns:
            List of remote names.
        """
        try:
            result = self._run_git(["remote"])
            output = result.stdout.decode("utf-8", errors="replace")
            return [r.strip() for r in output.split("\n") if r.strip()]
        except GitError:
            return []

    @property
    def name(self) -> str:
        """Get the backend name."""
        return "gitfs"

    def version(self) -> str | None:
        """Get the git version.

        Returns:
            Git version string or None.
        """
        try:
            result = self._run_git(["--version"])
            output = result.stdout.decode("utf-8", errors="replace")
            match = re.search(r"(\d+\.\d+\.\d+)", output)
            if match:
                return match.group(1)
        except GitError:
            pass
        return None
