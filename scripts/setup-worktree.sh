#!/bin/bash
# setup-worktree.sh — /create-mr Step 4：建立 per-ticket 隔離環境（固化歷次踩坑修法）
#
# 用法：bash scripts/setup-worktree.sh [--dry-run] <ticket_id> [affected_repo ...]
#   例：bash scripts/setup-worktree.sh FAQ-3710 agrabah rajah
#   affected_repo ∈ {agrabah, abu, lago, rajah}，可為空（全部 symlink，bootstrap 實質跑主 repo）
#
# 行為：
#   1. affected repo → 真 git worktree（branch mr/<ticket>，base origin/dev）；其餘主 repo + 共用庫 → symlink
#   2. node_modules：掃描主 repo 實際存在位置逐一 symlink（涵蓋 abu 等多子專案結構；踩坑 2026-07-01）
#   3. agrabah 為真 worktree 時補 .env.local symlink（踩坑 2026-07-02，缺它 migrate 硬中斷）
#   4. 跑 bootstrap.sh；失敗時自動判別「DB 資料供給層卡點」vs「真正失敗」
#   5. 從主 repo 鏡像補齊 worktree 缺的 gitignored 衍生產物（generated code）
#
# 輸出契約（給 pipeline manager 讀「最後一行」）：
#   SETUP_OK                      — 全部成功
#   SETUP_OK BOOTSTRAP_PARTIAL:db-seed — 程式碼生成完成，但 migrate/sync-* 等 DB 步驟失敗
#                                   （本腳本以錯誤樣式 grep 判別；人工復核法：在主 repo 跑同指令，
#                                     同錯 = 本機既有環境問題，非 worktree 造成。
#                                     只需 L0 測試的修復可續行，但必須在完成報告與 Notion 留言中明示披露）
#   SETUP_FAIL:<原因>             — 環境建立失敗（exit 1）
# 踩坑完整敘事：/Users/user/aladdin/.claude/doctrine/refs/pitfalls-worktree.md
set -u
ROOT=/Users/user/aladdin
WT_BASE=$ROOT/worktrees
MAIN_REPOS=(agrabah abu lago rajah)
SHARED=(jasmine genie jafar)

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
TICKET="${1:-}"; shift || true
AFFECTED=("$@")

# ---- 參數驗證 ----
echo "$TICKET" | grep -qE '^FAQ-[0-9]+$' || { echo "SETUP_FAIL:ticket_id 格式錯誤（需 FAQ-數字，收到 ${TICKET} ）"; exit 1; }
for r in "${AFFECTED[@]:-}"; do
  [ -z "$r" ] && continue
  case "$r" in agrabah|abu|lago|rajah) ;; *) echo "SETUP_FAIL:非法 repo ${r} （允許 agrabah/abu/lago/rajah）"; exit 1;; esac
done
WT=$WT_BASE/$TICKET

run() { # dry-run 包裝：只用於「會改變狀態」的指令
  if [ "$DRY" = 1 ]; then echo "DRY: $*"; else eval "$*"; fi
}

is_affected() { local x; for x in "${AFFECTED[@]:-}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

# ---- 1. 建 worktree ----
run "mkdir -p '$WT'"
for repo in "${AFFECTED[@]:-}"; do
  [ -z "$repo" ] && continue
  echo "== worktree: $repo =="
  ok=0
  for attempt in 1 2; do
    run "git -C '$ROOT/$repo' fetch origin dev --quiet"
    run "git -C '$ROOT/$repo' worktree remove '$WT/$repo' --force 2>/dev/null || true"
    run "git -C '$ROOT/$repo' branch -D 'mr/$TICKET' 2>/dev/null || true"
    if run "git -C '$ROOT/$repo' worktree add '$WT/$repo' -b 'mr/$TICKET' origin/dev"; then ok=1; break; fi
    echo "worktree add 失敗（attempt ${attempt} ），清殘留重試"
    run "git -C '$ROOT/$repo' worktree prune"
  done
  [ "$ok" = 1 ] || { echo "SETUP_FAIL:worktree add $repo 重試後仍失敗"; exit 1; }

  # ---- 2. node_modules：掃描主 repo 實際位置（踩坑 2026-07-01：abu 分散在 platform/admin 子專案）----
  find "$ROOT/$repo" -maxdepth 2 -type d -name node_modules -not -path "*/node_modules/*" 2>/dev/null \
    | while read -r nm; do
      rel="${nm#"$ROOT/$repo/"}"
      run "mkdir -p '$WT/$repo/$(dirname "$rel")'"
      run "ln -sfn '$nm' '$WT/$repo/$rel'"
      echo "node_modules symlink: $repo/$rel"
    done
  # .gitignore 的 node_modules/ 只比對目錄，symlink 是檔案不會被忽略 → 用 local exclude 讓 git 看不見
  # （info/exclude 屬 repo 共用目錄，對所有 worktree 生效；無斜線 pattern 可匹配任意深度的同名 symlink）
  if [ "$DRY" = 0 ]; then
    grep -qxF 'node_modules' "$ROOT/$repo/.git/info/exclude" 2>/dev/null || echo 'node_modules' >> "$ROOT/$repo/.git/info/exclude"
  fi
done

# ---- 3. 其餘主 repo + 共用庫 symlink ----
for repo in "${MAIN_REPOS[@]}"; do
  if ! is_affected "$repo"; then run "ln -sfn '$ROOT/$repo' '$WT/$repo'"; fi
done
for s in "${SHARED[@]}"; do run "ln -sfn '$ROOT/$s' '$WT/$s'"; done

# ---- 4. agrabah 為真 worktree 時補 .env.local（踩坑 2026-07-02）----
# .env.local 未進版控（.gitignore 排除），只存在主 repo；worktree checkout 不會帶到，
# 缺它時 bootstrap 尾段 `bun run migrate ControlCenter` 會 set -e 硬中斷。
if is_affected "agrabah" && [ -f "$ROOT/agrabah/.env.local" ]; then
  run "ln -sfn '$ROOT/agrabah/.env.local' '$WT/agrabah/.env.local'"
  if [ "$DRY" = 0 ]; then
    grep -qxF '.env.local' "$ROOT/agrabah/.git/info/exclude" 2>/dev/null || echo '.env.local' >> "$ROOT/agrabah/.git/info/exclude"
  fi
  echo "env symlink: agrabah/.env.local"
fi

# ---- 5. 驗證 ----
if [ "$DRY" = 0 ]; then
  for repo in "${AFFECTED[@]:-}"; do
    [ -z "$repo" ] && continue
    branch=$(git -C "$WT/$repo" branch --show-current 2>/dev/null)
    [ "$branch" = "mr/$TICKET" ] || { echo "SETUP_FAIL:${repo} branch=${branch} （預期 mr/${TICKET} ）"; exit 1; }
    # 驗 symlink 沒有懸空
    find "$WT/$repo" -maxdepth 2 -type l 2>/dev/null | while read -r l; do
      [ -e "$l" ] || echo "WARN: 懸空 symlink $l"
    done
  done
  echo "VERIFY_OK"
fi

# ---- 5.5 預先鏡像主 repo 的 gitignored 衍生產物（generated code）到 worktree（踩坑 2026-07-03）----
# 根因：rajah 為 symlink 時，bootstrap 的 `./generate-all.sh`（以 dirname 解析）把 generated 產物寫入「主 repo」agrabah，
# 但同一 bootstrap 尾段的 `migrate ControlCenter` / `sync-*` 以邏輯相對路徑 ../agrabah 對「worktree」agrabah 執行，
# 需要 worktree 內已存在 src/generated/services.gen.ts。原本負責鏡像的 Step 7 排在 bootstrap 之後，
# 而 migrate 因缺 generated 失敗（訊息不匹配 line 119 的 DB 樣式）即 exit → Step 7 永遠跑不到 → 每張 agrabah 單必然卡死。
# 2026-07-02 補 .env.local 讓 migrate 跨過「connection string」錯誤，反而往前暴露此「缺 generated」致命錯誤。
# 修法：bootstrap 前先把主 repo 已有的 gitignored generated 補進 worktree（只補缺的、不覆蓋；bootstrap 後 Step 7 仍會 top-up）。
if [ "$DRY" = 0 ]; then
  for repo in "${AFFECTED[@]:-}"; do
    [ -z "$repo" ] && continue
    ( cd "$ROOT/$repo" && git status --ignored --porcelain 2>/dev/null ) | grep '^!!' \
      | grep -vE 'node_modules|\.DS_Store|\.env|\.vscode' | sed 's/^!! //' | while read -r f; do
      f="${f%/}"
      dst="$WT/$repo/$f"
      if [ ! -e "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        cp -R "$ROOT/$repo/$f" "$dst"
      fi
    done
  done
  echo "pre-bootstrap derived-sync: OK"
fi

# ---- 6. bootstrap（rajah 驅動；rajah 為 symlink 時實質刷新主 repo，為真 worktree 時產物隔離在 worktree 內）----
BOOTSTRAP_STATUS="ok"
if [ "$DRY" = 1 ]; then
  echo "DRY: (cd '$WT/rajah' && sh bootstrap.sh)"
else
  BLOG="$WT/bootstrap.log"
  if ( cd "$WT/rajah" && sh bootstrap.sh ) >"$BLOG" 2>&1; then
    echo "bootstrap: OK"
  else
    if grep -qE 'ECONNREFUSED|unknownDatabaseError|can not found connection string|migrate \[[A-Za-z]+\] error\(|script "(sync-all|sync-configurations)" exited' "$BLOG"; then
      # DB 資料供給層卡點（migrate ControlCenter / sync-configurations / sync-all）。
      # 2026-07-30：原本只認連線層錯誤，schema 漂移（如 ER_DUP_FIELDNAME 導致的
      # migrate [Agent] error(12)）會誤判成「未知失敗」把整批 pipeline 擋死，故納入樣式。
      # 在此之前的程式碼生成（generate-genie / generate-configuration-files / generate-entries / generate-all）已完成，
      # 是後續 fixer 需要的東西。詳見 pitfalls-worktree.md「獨立問題」段。
      BOOTSTRAP_STATUS="partial"
      echo "bootstrap: DB 資料供給步驟失敗（尾 20 行如下），程式碼生成階段已完成"
      tail -20 "$BLOG"
    else
      echo "bootstrap: 未知失敗（尾 30 行如下）"
      tail -30 "$BLOG"
      echo "SETUP_FAIL:bootstrap 未知錯誤，完整 log 在 $BLOG"
      exit 1
    fi
  fi
fi

# ---- 7. 鏡像補齊 worktree 缺的 gitignored 衍生產物（只補缺的，已生成者不動）----
if [ "$DRY" = 0 ]; then
  for repo in "${AFFECTED[@]:-}"; do
    [ -z "$repo" ] && continue
    ( cd "$ROOT/$repo" && git status --ignored --porcelain 2>/dev/null ) | grep '^!!' \
      | grep -vE 'node_modules|\.DS_Store|\.env|\.vscode' | sed 's/^!! //' | while read -r f; do
      f="${f%/}"
      dst="$WT/$repo/$f"
      if [ ! -e "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        cp -R "$ROOT/$repo/$f" "$dst"
      fi
    done
  done
  echo "derived-sync: OK"
fi

if [ "$BOOTSTRAP_STATUS" = "partial" ]; then
  echo "SETUP_OK BOOTSTRAP_PARTIAL:db-seed"
else
  echo "SETUP_OK"
fi
