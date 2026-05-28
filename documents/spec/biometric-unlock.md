# 生体認証アンロック仕様

> SSOT for Issue [#49](https://github.com/AutoDevJapan/PassShare/issues/49)  
> 最終更新: 2026-05-28  
> 親 Epic: [#29](https://github.com/AutoDevJapan/PassShare/issues/29)

## 概要

PassShare は OS ネイティブの生体認証（Windows Hello / Touch ID / Face ID / 指紋）で **マスターパスワード入力を省略** できるオプションを提供する。

- **Desktop（Should）:** `tauri-plugin-biometry` + `@choochmeque/tauri-plugin-biometry-api`
- **Mobile（Must）:** 同一プラグイン（Tauri Mobile ビルド時）。Epic [#33](https://github.com/AutoDevJapan/PassShare/issues/33) / [#78](https://github.com/AutoDevJapan/PassShare/issues/78) で `apps/mobile` scaffold 後に E2E 検証

## 用語

| 概念 | 説明 |
|------|------|
| マスターパスワード | ローカル `.pbox` 復号用。サーバーには送らない（ADR 004） |
| 生体認証で開く | OS Secure Storage に保存したマスターパスワードを、生体認証成功後に取得して開く |

## フロー

### 有効化（Desktop `/app` 設定）

1. ユーザーがマスターパスワードでパスワードボックスを開く
2. 設定 →「生体認証で開く」→ 有効化
3. OS 生体認証プロンプト → 成功後、Secure Storage に `master-password:{boxPath}` として保存

### 次回起動

1. セットアップ画面で「生体認証で開く」を表示（保存済みかつ OS 対応時）
2. 生体認証成功 → マスターパスワード取得 → `openPasswordBox`

## 実装

| レイヤー | パス |
|---------|------|
| JS API ラッパー | `apps/desktop/src/biometric-unlock.ts` |
| 設定 UI | `apps/desktop/src/components/BiometricUnlockSettings.tsx` |
| セットアップ | `apps/desktop/src/components/SetupPanel.tsx` |
| Tauri プラグイン | `apps/desktop/src-tauri/Cargo.toml` (`tauri-plugin-biometry`) |
| 権限 | `capabilities/default.json` → `biometry:default` |

## プラットフォーム

| OS | 対応 | 備考 |
|----|------|------|
| Windows | ✅ | Windows Hello |
| macOS | ✅ | Touch ID（コード署名推奨） |
| iOS / Android | ✅ | Tauri Mobile ビルド時（公式プラグイン同一 API） |
| Linux | — | 生体認証 UI 非表示 |

## 受入基準 (Issue #49)

```gherkin
Given Desktop でパスワードボックスを開いた
When  生体認証で開くを有効にする
Then  次回起動時に生体認証で開くボタンが表示される

Given Mobile（Tauri Mobile）で生体認証が利用可能
When  生体認証で開くを実行する
Then  Face ID / 指紋プロンプト後にパスワードボックスが開く
```

## 関連

- [ADR 004: 認証・認可](../adr/004-auth-authorization-model.md)
- [production-v2.md](./production-v2.md)
