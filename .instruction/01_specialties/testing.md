## テスト指針（SDD x ATDD / SSOT）

### 目的
「仕様→テスト→実装」の順序を守り、テストが仕様の証明として機能する状態を維持する。

---

## ATDD（Acceptance Test-Driven Development）フロー

### 基本サイクル
```
1. 仕様確定（Spec）
   ↓
2. 受け入れ条件を Given-When-Then で定義
   ↓
3. 受け入れテストを先に書く（Red）
   ↓
4. 実装（Green）
   ↓
5. リファクタリング
   ↓
6. 回帰テストとして維持
```

### Given-When-Then の書き方
```gherkin
Given [前提条件：システムの初期状態]
When [操作/イベント：ユーザーまたはシステムの行動]
Then [期待結果：検証可能な結果]
```

**良い例：**
```gherkin
Given ユーザーがログイン済みで、商品一覧画面を表示している
When 「カートに追加」ボタンをクリックする
Then カート内の商品数が1増加し、トースト通知が表示される
```

**悪い例：**
```gherkin
Given いい感じの状態
When 適切に操作する
Then 正常に動作する
```
→ 曖昧で検証不可能

---

## テスト層の責務

| 層 | 対象 | 速度 | 目的 |
|----|------|------|------|
| **unit** | Domain/Usecase/UIロジック | 高速 | ビジネスルールの検証 |
| **integration** | API/DB/外部I/O | 中速 | 境界の検証 |
| **e2e** | 画面操作 | 低速 | ユーザー体験の検証 |

### 優先順位
1. **unit を最優先**：ビジネスルールと失敗条件を最短で固定
2. **integration は要所のみ**：バリデーション/例外/永続化の境界
3. **e2e は重要フローのみ**：ログイン/主要CRUD/決済など

---

## テストを先に書くタイミング

| シナリオ | テストを先に書く？ |
|----------|-------------------|
| 新機能追加 | ✅ 受け入れ条件からテストを先に書く |
| バグ修正 | ✅ 再現テストを先に書く |
| リファクタリング | ⚠️ 既存テストがあれば不要、なければ先に追加 |
| 探索的実装 | ⚠️ プロトタイプ後にテスト追加でも可 |

---

## テストケースの設計

### 必須観点
1. **正常系**：期待通りの入力で期待通りの結果
2. **異常系**：不正入力/権限不足/存在しない場合
3. **境界値**：0/1/MAX/空/null

### テストケーステンプレート
```
【テスト名】[対象]_[条件]_[期待結果]
【前提】Given: ...
【操作】When: ...
【検証】Then: ...
```

---

## コマンド（正本）

### Frontend（React + TypeScript）
```bash
pnpm -C frontend test          # unit
pnpm -C frontend test:e2e      # e2e（整備後）
```

### Backend（FastAPI + Python）
```bash
cd backend && uv run pytest -q                    # unit
cd backend && uv run pytest -m integration -q    # integration（DB必要）
```

### 品質ゲート（全体）
```bash
pnpm quality-gate
pnpm preflight:integration  # DB込みの統合テスト
```

---

## 「書けないテスト」は設計臭

テストが書きづらい場合、以下を疑う：
- I/O境界が漏れている（Domainが直接DBを触っている）
- 責務が混ざっている（1関数が複数のことをしている）
- 依存が多すぎる（モックが大量に必要）

→ テストを書く前に設計を見直す

---

## 実装参照
- Feature Template: `documents/spec/feature-template.md`
- テスト計画テンプレート: `documents/templates/test-plan-template.md`
