## 目的
設計（API/ドメイン/DB/UI）判断の基準を統一し、実装可能な設計へ落とす。

## 設計の順序（MUST）
1. **Spec（仕様）を確定**（`documents/spec/`）
2. **影響範囲分析**（`documents/templates/impact-analysis-template.md`）
3. **設計判断**（責務分離/型/エラー/ログ/互換性/移行）
4. **最小の確認手順**（`documents/templates/test-plan-template.md`）

## 設計観点（チェックリスト）
### API（REST）
- エンドポイント/入出力/エラー/互換性（追加はoptional、削除/変更は移行必須）
- 認証/認可が必要か（現状/将来導入の前提を明記）
- ログ方針（利用者向け/内部向け、秘密情報を出さない）

### DB（MySQL + Alembic）
- DDL差分（追加/変更/削除）と互換性
- データ移行（バックフィル）とロールバック
- インデックス（想定クエリ起点）

### ドメイン（DDD）
- Domainにルールが集約されているか
- Usecaseがトランザクション境界になっているか
- InfrastructureにI/Oが閉じているか

### UI（Electron/React）
- UIと副作用が分離されているか
- loading/error/empty/normal が揃っているか
- ユーザーが行動できるエラーメッセージになっているか

