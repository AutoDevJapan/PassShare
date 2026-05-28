# 拡張機能インストールガイド

> Issue [#112](https://github.com/AutoDevJapan/PassShare/issues/112)  
> Web: `/docs/extension`  
> 最終更新: 2026-05-28

## ビルド

```powershell
cd packages/extension
pnpm install
pnpm --dir ../connect-js run build
pnpm run build
```

成果物: `packages/extension/dist/`

## Google Chrome

1. `chrome://extensions` を開く
2. **デベロッパーモード** を ON
3. **パッケージ化されていない拡張機能を読み込む** → `dist/` を選択
4. ツールバーの PassShare アイコンからログイン

## Microsoft Edge

1. `edge://extensions` を開く
2. **デベロッパーモード** を ON
3. **拡張機能を読み込む** → `dist/` を選択

## Mozilla Firefox

1. `dist/` を zip 化（ルートに `manifest.json`）
2. `about:debugging` → **一時アドオンを読み込む**
3. zip ファイルを選択

## Apple Safari

Safari 向けは Xcode 経由の Web Extension 変換が必要です。ストア公開前は開発者向け手順のみ:

- SSOT: [extension-store-release.md](../runbooks/extension-store-release.md) Safari 節
- 一般ユーザー向け App Store 手順はストア公開後に本ガイドを更新

## 関連

- [extension-ui.md](../spec/extension-ui.md)
- [extension-store-release.md](../runbooks/extension-store-release.md)
