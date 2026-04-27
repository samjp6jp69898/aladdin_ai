# method-call-graph

分析指定 service method 的完整呼叫鏈，涵蓋同 server caller、跨 server gRPC caller、前端 caller、三方回調觸發路徑四個維度。

## 用法

**Service Method 模式** — 分析某個方法被誰呼叫：

```
/method-call-graph <ServiceClass>.<method>
```

例如：`/method-call-graph PaymentService.methodChangeUserBalance`

**Table CRUD 模式** — 追蹤某個 server 中哪些方法操作指定的表：

```
/method-call-graph table <server> <table_name>
```

例如：`/method-call-graph table payment payment_discount_record`
