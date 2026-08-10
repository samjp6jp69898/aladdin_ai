#!/bin/bash
# dep-worktree.sh — /dep-audit Step 5：建立「升版實測」用的隔離環境。
#
# 用法：
#   bash dep-worktree.sh create  <label> <repo...>   # repo ∈ agrabah|abu|lago|rajah
#   bash dep-worktree.sh install <label> [proj_id..] # 在 worktree 內跑各專案的 install（慢，數分鐘起跳）
#   bash dep-worktree.sh verify  <label> [proj_id..] # 跑 projects.json 的 verify 步驟（基準線與升版後都用這個）
#   bash dep-worktree.sh sync-derived <label> <repo...>  # 補鏡像 gitignored 產生碼（create 已內含，可單獨重跑）
#   bash dep-worktree.sh status  <label>
#   bash dep-worktree.sh remove  <label>
#
# 設計要點（每一條都對應一個會讓實測失效的坑）：
#   1. worktree 一律 **detached HEAD**（不建分支）。dep-audit 只驗證、不交付程式碼，
#      沒有分支就沒有可 push 的東西，天然符合 CLAUDE.md「git push 一律禁止」。
#   2. genie / jafar / jasmine 以 symlink 放進 worktree 根：各專案用 ../genie、../../jafar
#      這類相對路徑依賴，缺了它們 bun install 直接解不到。
#   3. 從主 repo 鏡像 .env* （.env.local 等被 gitignore、worktree 不會有）：
#      缺 env 的 vite build 會以另一組設定編譯，實測結果不可信。
#   4. 從主 repo 鏡像 gitignored 的產生碼（src/generated/*.gen.* 等）：rajah 生成的程式碼不進 git，
#      新 worktree 一定缺。缺了 abu/lago 的 vite build 會在 src/main.ts 炸
#      「Could not resolve ./generated/remote.gen.ts」、agrabah typecheck 會噴一串 TS2307——
#      基準線全紅、與升版無關（2026-07-29 實測踩過）。做法沿用 setup-worktree.sh 的 derived-sync。
#   5. 不跑 bootstrap.sh、不跑 migrate、不碰 DB——本流程只需要能 install / typecheck / build。
#
# 輸出契約（manager 讀最後一行）：
#   WORKTREE_OK <path>          / WORKTREE_FAIL:<原因>
#   INSTALL_OK <n>/<n>          / INSTALL_PARTIAL <ok>/<n>（明細見 stdout 每行 INSTALL_<STATUS> <proj>）
#   VERIFY <proj> <step> <PASS|FAIL> <秒數>  每步一行；末行 VERIFY_DONE <pass>/<total>
set -u

ROOT=/Users/user/aladdin
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED="genie jafar jasmine"
VALID_REPOS="agrabah abu lago rajah"

ACTION="${1:-}"
LABEL="${2:-}"
[ -z "$ACTION" ] && { echo "WORKTREE_FAIL:缺 action（create|install|verify|sync-derived|status|remove）"; exit 1; }
[ -z "$LABEL" ] && { echo "WORKTREE_FAIL:缺 label"; exit 1; }
echo "$LABEL" | grep -qE '^[A-Za-z0-9._-]+$' || { echo "WORKTREE_FAIL:label 只允許英數 . _ - （收到 ${LABEL} ）"; exit 1; }

BASE="$ROOT/worktrees/dep-audit-$LABEL"
shift 2 || true

# 鏡像主 repo 的 gitignored 衍生產物（產生碼）到 worktree。只補缺的、不覆蓋。
# 做法沿用 scripts/setup-worktree.sh 的 derived-sync：git status --ignored 列出被忽略的路徑，
# 排除 node_modules / .env / 編輯器設定後整份 cp 過去。
sync_derived() {
  local n=0
  for repo in "$@"; do
    [ -d "$BASE/$repo" ] || continue
    while IFS= read -r f; do
      f="${f%/}"
      [ -z "$f" ] && continue
      local dst="$BASE/$repo/$f"
      if [ ! -e "$dst" ]; then
        mkdir -p "$(dirname "$dst")"
        cp -R "$ROOT/$repo/$f" "$dst" 2>/dev/null && n=$((n + 1))
      fi
    done <<EOF
$( (cd "$ROOT/$repo" && git status --ignored --porcelain 2>/dev/null) | grep '^!!' \
   | grep -vE 'node_modules|\.DS_Store|\.env|\.vscode' | sed 's/^!! //' )
EOF
  done
  echo "  鏡像產生碼：${n} 個路徑"
}

# ---------------------------------------------------------------- remove
if [ "$ACTION" = "remove" ]; then
  for repo in $VALID_REPOS; do
    [ -d "$BASE/$repo" ] || continue
    git -C "$ROOT/$repo" worktree remove "$BASE/$repo" --force 2>/dev/null \
      || echo "  警告：$repo worktree 移除失敗，稍後可跑 git -C $ROOT/$repo worktree prune"
  done
  rm -rf "$BASE"
  for repo in $VALID_REPOS; do git -C "$ROOT/$repo" worktree prune 2>/dev/null; done
  echo "WORKTREE_REMOVED $BASE"
  exit 0
fi

# ---------------------------------------------------------------- status
if [ "$ACTION" = "status" ]; then
  [ -d "$BASE" ] || { echo "WORKTREE_MISSING $BASE"; exit 1; }
  echo "base: $BASE"
  for e in "$BASE"/*; do
    [ -e "$e" ] || continue
    n=$(basename "$e")
    if [ -L "$e" ]; then echo "  $n -> symlink $(readlink "$e")"
    else echo "  $n -> worktree @ $(git -C "$e" rev-parse --short HEAD 2>/dev/null || echo '?')"; fi
  done
  echo "WORKTREE_OK $BASE"
  exit 0
fi

# ---------------------------------------------------------------- create
if [ "$ACTION" = "create" ]; then
  REPOS="$*"
  [ -z "$REPOS" ] && { echo "WORKTREE_FAIL:create 需要至少一個 repo（${VALID_REPOS} ）"; exit 1; }
  for r in $REPOS; do
    echo " $VALID_REPOS " | grep -q " $r " || { echo "WORKTREE_FAIL:非法 repo ${r} （允許 ${VALID_REPOS} ）"; exit 1; }
  done

  mkdir -p "$BASE" || { echo "WORKTREE_FAIL:無法建立 $BASE"; exit 1; }

  for repo in $REPOS; do
    echo "== worktree: $repo =="
    git -C "$ROOT/$repo" fetch origin dev --quiet 2>/dev/null || echo "  警告：fetch origin dev 失敗，改用本地既有 ref"
    git -C "$ROOT/$repo" worktree remove "$BASE/$repo" --force 2>/dev/null
    git -C "$ROOT/$repo" worktree prune 2>/dev/null
    BASEREF=origin/dev
    git -C "$ROOT/$repo" rev-parse --verify --quiet "$BASEREF" >/dev/null || BASEREF=HEAD
    # --detach：不建分支，實測環境不可能被 push
    if ! git -C "$ROOT/$repo" worktree add --detach "$BASE/$repo" "$BASEREF" >/dev/null 2>&1; then
      echo "WORKTREE_FAIL:${repo} worktree add 失敗（base=${BASEREF} ）"; exit 1
    fi
    echo "  $repo @ $(git -C "$BASE/$repo" rev-parse --short HEAD) (detached from $BASEREF)"
  done

  # 相對路徑依賴：../genie、../../jafar …
  for s in $SHARED; do
    [ -d "$ROOT/$s" ] || continue
    [ -e "$BASE/$s" ] || ln -s "$ROOT/$s" "$BASE/$s"
  done
  echo "  shared symlink: $SHARED"

  # 鏡像 .env*（.env.local 等被 gitignore，worktree 不會有；缺了 build 結果不可信）
  ENVN=0
  for repo in $REPOS; do
    while IFS= read -r rel; do
      src="$ROOT/$repo/$rel"
      dst="$BASE/$repo/$rel"
      [ -f "$src" ] || continue
      [ -e "$dst" ] && continue
      mkdir -p "$(dirname "$dst")"
      cp -p "$src" "$dst" && ENVN=$((ENVN + 1))
    done <<EOF
$(cd "$ROOT/$repo" && find . -maxdepth 2 -name '.env*' -type f 2>/dev/null | sed 's|^\./||')
EOF
  done
  echo "  鏡像 env 檔：${ENVN} 個"

  sync_derived $REPOS

  echo "WORKTREE_OK $BASE"
  exit 0
fi

# ---------------------------------------------------------------- sync-derived
if [ "$ACTION" = "sync-derived" ]; then
  [ -d "$BASE" ] || { echo "WORKTREE_FAIL:$BASE 不存在，請先 create"; exit 1; }
  REPOS="$*"
  [ -z "$REPOS" ] && REPOS="$VALID_REPOS"
  sync_derived $REPOS
  echo "WORKTREE_OK $BASE"
  exit 0
fi

# ---------------------------------------------------------------- install
if [ "$ACTION" = "install" ]; then
  [ -d "$BASE" ] || { echo "WORKTREE_FAIL:$BASE 不存在，請先 create"; exit 1; }
  WANT="$*"

  # 從 projects.json 取「路徑 + install 指令」，只保留 worktree 內真的存在的專案
  PLAN=$(bun -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1] + "/projects.json", "utf8"));
    const base = process.argv[2];
    const want = (process.argv[3] || "").trim().split(/\s+/).filter(Boolean);
    for (const p of cfg.projects) {
      if (want.length && !want.includes(p.id)) continue;
      if (!fs.existsSync(base + "/" + p.path + "/package.json")) continue;
      console.log([p.id, p.path, p.install].join("\t"));
    }
  ' "$SKILL_DIR" "$BASE" "$WANT") || { echo "WORKTREE_FAIL:讀取 projects.json 失敗"; exit 1; }

  [ -z "$PLAN" ] && { echo "WORKTREE_FAIL:worktree 內沒有可安裝的專案（create 時是否漏帶 repo？）"; exit 1; }

  TOTAL=0; OKN=0
  while IFS=$'\t' read -r pid ppath pcmd; do
    [ -z "$pid" ] && continue
    TOTAL=$((TOTAL + 1))
    echo "== install: $pid （$pcmd ）=="
    if (cd "$BASE/$ppath" && eval "$pcmd") >"$BASE/.install-$pid.log" 2>&1; then
      OKN=$((OKN + 1)); echo "INSTALL_OK $pid"
    else
      echo "INSTALL_FAIL $pid  （log: $BASE/.install-$pid.log 末 20 行）"
      tail -20 "$BASE/.install-$pid.log" | sed 's/^/    /'
    fi
  done <<EOF
$PLAN
EOF

  if [ "$OKN" = "$TOTAL" ]; then echo "INSTALL_OK $OKN/$TOTAL"; else echo "INSTALL_PARTIAL $OKN/$TOTAL"; fi
  exit 0
fi

# ---------------------------------------------------------------- verify
if [ "$ACTION" = "verify" ]; then
  [ -d "$BASE" ] || { echo "WORKTREE_FAIL:$BASE 不存在，請先 create"; exit 1; }
  WANT="$*"
  TAG="${DEP_AUDIT_PHASE:-run}"     # 建議 baseline / after，只用來區分 log 檔名

  PLAN=$(bun -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1] + "/projects.json", "utf8"));
    const base = process.argv[2];
    const want = (process.argv[3] || "").trim().split(/\s+/).filter(Boolean);
    for (const p of cfg.projects) {
      if (want.length && !want.includes(p.id)) continue;
      if (!fs.existsSync(base + "/" + p.path + "/node_modules")) continue;   // 沒裝起來的不驗
      for (const v of p.verify) console.log([p.id, p.path, v.name, v.cmd].join("\t"));
    }
  ' "$SKILL_DIR" "$BASE" "$WANT") || { echo "WORKTREE_FAIL:讀取 projects.json 失敗"; exit 1; }

  [ -z "$PLAN" ] && { echo "WORKTREE_FAIL:沒有可驗證的專案（node_modules 未安裝？先跑 install）"; exit 1; }

  TOTAL=0; OKN=0
  while IFS=$'\t' read -r pid ppath vname vcmd; do
    [ -z "$pid" ] && continue
    TOTAL=$((TOTAL + 1))
    LOG="$BASE/.verify-$TAG-$pid-$vname.log"
    T0=$(date +%s)
    if (cd "$BASE/$ppath" && eval "$vcmd") >"$LOG" 2>&1; then ST=PASS; OKN=$((OKN + 1)); else ST=FAIL; fi
    T1=$(date +%s)
    echo "VERIFY $pid $vname $ST $((T1 - T0))"
    [ "$ST" = FAIL ] && tail -6 "$LOG" | sed 's/^/    /'
  done <<EOF
$PLAN
EOF

  echo "VERIFY_DONE $OKN/$TOTAL"
  exit 0
fi

echo "WORKTREE_FAIL:未知 action ${ACTION} （create|install|verify|status|remove）"
exit 1
