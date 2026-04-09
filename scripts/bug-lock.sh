#!/bin/bash
# Bug 任務鎖管理
#
# 用法：
#   bash scripts/bug-lock.sh claim <單號>    # 認領任務（原子操作）
#   bash scripts/bug-lock.sh release <單號>  # 釋放鎖
#   bash scripts/bug-lock.sh status <單號>   # 查詢鎖狀態
#   bash scripts/bug-lock.sh cleanup         # 清理所有鎖
#   bash scripts/bug-lock.sh list            # 列出所有鎖
#
# 退出碼：
#   0 = 成功
#   1 = 失敗（已被認領 / 參數錯誤）

LOCK_DIR="/tmp/bug-analysis-locks"

# 確保鎖目錄存在
mkdir -p "$LOCK_DIR"

ACTION="$1"
TICKET="$2"

case "$ACTION" in
    claim)
        if [ -z "$TICKET" ]; then
            echo "ERROR: 請提供單號，例如：bash scripts/bug-lock.sh claim FAQ-1841"
            exit 1
        fi
        # mkdir 是原子操作，只有一個 process 能成功
        if mkdir "$LOCK_DIR/$TICKET" 2>/dev/null; then
            # 寫入認領資訊
            echo "pid=$$" > "$LOCK_DIR/$TICKET/info"
            echo "time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOCK_DIR/$TICKET/info"
            echo "CLAIMED: $TICKET"
            exit 0
        else
            echo "LOCKED: $TICKET 已被其他 session 認領"
            if [ -f "$LOCK_DIR/$TICKET/info" ]; then
                cat "$LOCK_DIR/$TICKET/info"
            fi
            exit 1
        fi
        ;;
    release)
        if [ -z "$TICKET" ]; then
            echo "ERROR: 請提供單號"
            exit 1
        fi
        if [ -d "$LOCK_DIR/$TICKET" ]; then
            rm -rf "$LOCK_DIR/$TICKET"
            echo "RELEASED: $TICKET"
            exit 0
        else
            echo "NOT_LOCKED: $TICKET 沒有鎖"
            exit 0
        fi
        ;;
    status)
        if [ -z "$TICKET" ]; then
            echo "ERROR: 請提供單號"
            exit 1
        fi
        if [ -d "$LOCK_DIR/$TICKET" ]; then
            echo "LOCKED: $TICKET"
            if [ -f "$LOCK_DIR/$TICKET/info" ]; then
                cat "$LOCK_DIR/$TICKET/info"
            fi
            exit 1
        else
            echo "FREE: $TICKET"
            exit 0
        fi
        ;;
    cleanup)
        if [ -d "$LOCK_DIR" ]; then
            rm -rf "$LOCK_DIR"/*
            echo "CLEANUP: 所有鎖已清除"
        fi
        exit 0
        ;;
    list)
        if [ -d "$LOCK_DIR" ] && [ "$(ls -A "$LOCK_DIR" 2>/dev/null)" ]; then
            echo "目前持有的鎖："
            for lock in "$LOCK_DIR"/*/; do
                ticket=$(basename "$lock")
                echo "  $ticket"
                if [ -f "$lock/info" ]; then
                    sed 's/^/    /' "$lock/info"
                fi
            done
        else
            echo "目前沒有任何鎖"
        fi
        exit 0
        ;;
    *)
        echo "用法：bash scripts/bug-lock.sh {claim|release|status|cleanup|list} [單號]"
        exit 1
        ;;
esac
