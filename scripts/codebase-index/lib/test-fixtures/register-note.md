---
type: rpc-method
fqn: appUser.appUser.Register
source_file: lib/test-fixtures/register-source-step15.ts.snippet
source_line: 14
last_scanned: 2026-04-22
human_edited: false
---

# appUser.appUser.Register

## 功能描述

App 會員註冊主流程。

詳細步驟：

1. `prepareProviderData` 守衛
2. 清 otp session、送 `RecordUserLogin(register, loginSuccess)` job、`updatePlatformStatistic(registerMembers)`

## 業務場景

- App / H5 前台註冊表單提交
