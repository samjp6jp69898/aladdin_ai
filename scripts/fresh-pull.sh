#!/bin/bash
# fresh-pull.sh — /create-mr Step 0：建 worktree 前，先把共用主 repo 全部拉新
#
# 背景：Step 4（setup-worktree.sh）2026-08-21 起改成從 origin/main 開分支
# （main 遷移計畫進行中，見 setup-worktree.sh 檔頭註解）。要讓每次 /create-mr
# 都真的抓到最新 main，必須在建 worktree 前先對 rajah/jasmine/genie/agrabah/
# jafar/abu/lago/cassim 這 8 個共用主 repo 跑一次 git pull——這正是
# rajah/update.sh 已經在做的事，本腳本只是加一把鎖再呼叫它。
#
# 為什麼要鎖：telegram-dispatcher 併發上限是 5（GLOBAL_CONCURRENCY_LIMIT，見
# telegram-dispatcher/lib/pipeline-runner/concurrency-limiter.ts），多張單
# 幾乎同時觸發時，若各自的 /create-mr Step 0 同時對同一份共用主 repo 跑
# git pull，會撞 .git/index.lock（git 對同一 repo 的並行寫入操作本來就不安
# 全）。用跟 scripts/tracker.sh 的 SETLOCK 完全同款的 mkdir 互斥鎖 idiom
# （bash 唯一的原子性判斷手段），把 8 個 repo 的 pull 序列化；等待迴圈的
# sleep 只是鎖的 backoff、不是拿它取代結構性保證——真正的互斥靠 mkdir 的
# 原子性，這跟 tracker.sh 既有寫法同一套，非新發明。
#
# 用法：bash scripts/fresh-pull.sh
#
# 輸出契約（manager 讀最後一行）：
#   FRESH_PULL_OK
#   FRESH_PULL_FAIL:<原因，含 log 路徑>
set -u
LOCK=/tmp/bug-analysis-locks/.fresh-pull-lock
mkdir -p "${LOCK%/*}"

n=0
until mkdir "$LOCK" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 300 ]; then
    echo "FRESH_PULL_FAIL:等鎖逾時（${LOCK} 疑似殘留，確認沒有其他 /create-mr 在跑 fresh-pull 後可 rmdir）"
    exit 1
  fi
  sleep 0.5
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

LOG=$(mktemp /tmp/fresh-pull.XXXXXX.log)
if (cd /Users/user/aladdin/rajah && bash update.sh) >"$LOG" 2>&1; then
  echo "FRESH_PULL_OK"
else
  echo "FRESH_PULL_FAIL:update.sh 非零結束，log：$LOG"
  exit 1
fi
