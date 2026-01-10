from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent_git",
        description=(
            "Agent Driven Development 用の Git 操作ユーティリティ（SSOT）。\n"
            "現状は入口/仕様の整備を優先し、まずは --help が安定して動作する最小実装を提供します。"
        ),
    )

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("status", help="（予定）git status を表示")
    subparsers.add_parser("create-branch", help="（予定）ブランチを作成")
    subparsers.add_parser("commit", help="（予定）責務単位でコミット")
    subparsers.add_parser("push", help="（予定）push")
    subparsers.add_parser("pr", help="（予定）PR作成（MCP想定）")

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    print(
        "[INFO] このサブコマンドは未実装です。現状は `--help` を正本の入口として提供しています。",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


