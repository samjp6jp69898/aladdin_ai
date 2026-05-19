# FIX-AUTHORITY IRON LAW（共用鐵律）

> bug-tracer / bug-tracer-with-callgraph / backtest-commit-analyzer 共用。本檔為「判定 bug 是否已修復、哪顆 commit 是該修復」之唯一權威規範；與各 agent 內舊啟發式衝突時以本檔為準。**全篇抽象、零特定單號；`NNNN` 為不含數字之佔位符，代表本案 ticket 數字部分。**

## A. ticket-id 完全相同 = 唯一第一權威

1. 一個 commit 是否為「本 ticket 的修復」，唯一第一權威 = 其 commit message（subject 或 body）含與本 ticket 完全相同的 ticket-id。
2. ticket-id 比對必須涵蓋全變體，逐 repo 跨全部受查 repo（tracer：agrabah / abu / lago / rajah；commit-analyzer：依其既有 repo 清單，含 genie），grep 一律加 `-i`，且須涵蓋 commit body（`git log --grep` 預設即搜尋完整訊息含 subject 與 body，**不需**另加 `--format`，加了反而會限縮）：
   - 標準式：`[FAQ-NNNN]`、`(FAQ-NNNN)`、`FAQ-NNNN`
   - 拼字／無分隔變體：`[FQA-NNNN]`、`FAQNNNN`、`FAQ_NNNN`、`FAQ NNNN`
   - 複合前綴：`[PK][NNNN]`、`[PK][FAQ-NNNN]`、`[平台][FAQ-NNNN]`、其他 `[品牌標籤][...NNNN]`
   - 裸號式：`[NNNN]`、`#NNNN`、空白包夾 ` NNNN `（須前後為非數字邊界，正規式 `(^|[^0-9])NNNN([^0-9]|$)`，避免誤命中其他數字）
   - 建議指令（`NNNN` 換成本案數字；`git log` 多個 `--grep` 為 OR；用 `-E` 延伸正規式）：
     ```
     git -C <repo> log --all -i -E \
       --grep='FAQ[-_ ]?NNNN' \
       --grep='FQA[-_ ]?NNNN' \
       --grep='(^|[^0-9])NNNN([^0-9]|$)'
     ```
     第三條（裸號）會過度命中（任何含該數字的 commit 都中），故裸號命中**必須**人工確認其上下文確為本 ticket（`[NNNN]`/`#NNNN`/前後括號）再採信，不得單憑裸號數字逕判 fix。
3. 命中完全相同 ticket-id 的 commit → 它即 fix 權威。以其 diff 判定歸屬與「已修復」，不得被任何「看起來更像 fix／訊息更貼切」的他單 commit 蓋過。

## B. 全變體跨全 repo 皆無命中 → 才進 code 取證 fallback（硬規則，違反即輸出無效）

1. 禁止把 commit message 掛別 ticket-id（與本案不同的任何 FAQ/FQA 號）的 commit 當本 ticket 的 fix 權威 —— 此為歷史頭號 false-negative 噪音源。掛別單號者至多列「同檔鄰近改動參考」，不得作 fix 結論。
2. 禁止選 commit date 早於本案報案日的 commit 當 fix。唯一例外：以客觀祖先判定（`git merge-base --is-ancestor <commit> <報案時版本>` exit 0）證明該 commit 已含於報案版本，**且**報案版本症狀仍在（「症狀仍在」由呼叫端 agent 依其症狀證據判定：報案時版本 / HEAD 的 code 證據顯示症狀存在）→ 屬另案，仍不得當本案 fix。
3. code 取證（HEAD 症狀是否仍在 + 症狀路徑 source）亦無定論 → 結論「真 fix 未進 git（INSUFFICIENT-EVIDENCE）」，不得硬指一顆 commit。

## C. 多顆完全相同 ticket-id commit → 源頭優先仲裁（禁 min-hop）

當 §A 命中 ≥2 顆完全相同 ticket-id commit（跨 repo 或多顆）：
1. 全部讀 diff（`git show <hash> -- <file>`）。
2. 主歸屬 = diff 修在「症狀源頭／產生點」那一側：資料被首次錯誤產生/轉換/寫入處，或契約（協議/schema/enum）定義處。偵測點（擋壞資料、回 errorCode）、下游消費點、症狀渲染點，即使其 diff 字面離症狀更近，也只列 companion secondary，不得當主因。契約（協議/schema/enum）定義處與業務邏輯首次寫入處不同時，定義處優先；兩者為同一處則並列 primary。
3. 明文禁止任何「取 hop 最小／離症狀產出點最近者為主因」「diff 須在症狀產出點 hop ≤ 1 才採信改判」式規則。真根因常在症狀產出點上游多跳處；min-hop / hop≤1 守衛會把歸屬反錨回下游、重演 wrong-side（歷史複驗抓到的反向矯枉過正教訓）。
4. 多顆同 ticket-id commit 全部納入「已修復涵蓋」驗證：源頭側 + companion 側都被涵蓋才算完整修復；主因判定恆歸源頭側，不因 companion 側訊息更像 fix 而改判。

## D. 適用聲明

- 本鐵律凌駕各 agent 內「commit message 字面像不像 fix」「選證據最深的 commit」「diff 離症狀近就採信」等舊啟發式。
- 各 agent 內與本鐵律衝突之舊條文以本鐵律為準，並於分析輸出（若輸出格式允許自由文字）註記衝突點。
- 全程不得在分析輸出寫死任何特定 ticket 單號作範例。
