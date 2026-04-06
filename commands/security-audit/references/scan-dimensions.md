# 安全审计扫描维度参考

根据项目技术栈和业务特征，从以下维度中选择适用项进行扫描。每个维度列出搜索关键词和关注点。

**使用方式**：不要机械地搜索所有关键词。先理解项目架构，再选择相关维度，根据项目实际技术栈调整搜索模式。

---

## 1. 认证与会话管理

**搜索模式**: `jwt|token|session|auth|login|password|credential|cookie|bearer|oauth|saml|sso|apikey|api_key`

**关注点**:
- Token 生成：算法强度、密钥管理、过期策略
- Token 验证：是否被注释/跳过、是否检查过期、签名验证是否完整
- 密码处理：哈希算法（bcrypt/argon2/scrypt vs MD5/SHA1）、salt、迭代次数
- 会话生命周期：创建、续期、登出失效、空闲超时、多设备管理
- 认证绕过：条件性检查可跳过、默认放行逻辑、fallback 到弱认证
- 记住我/持久登录：凭据存储方式、密钥与密文是否同存

## 2. 授权与访问控制

**搜索模式**: `permission|role|admin|authorize|access|privilege|hasPermission|canEdit|isAdmin|isSuper|guard|middleware|policy|acl|rbac`

**关注点**:
- IDOR：用户可控 ID 参数 vs context.userId，缺少所有权验证
- 权限硬编码：`= true`、TODO 占位、注释掉的检查
- 垂直越权：普通用户访问管理功能、缺少角色检查
- 水平越权：跨用户/跨租户/跨平台数据访问
- 权限检查层级：仅 UI 层 vs 路由层 vs API 层 vs 数据库层
- 默认权限：空权限列表/白名单 = 全部放行？
- 缓存隔离：权限缓存是否区分租户/平台

## 3. 注入攻击

**搜索模式**: `\$\{|\.query\(|\.exec\(|\.execute\(|eval\(|Function\(|child_process|spawn|exec|system\(|popen|subprocess|template|render|compile`

**关注点**:
- SQL 注入：字符串拼接 vs 参数化查询，ORM 的 raw query
- NoSQL 注入：MongoDB `$where`、`$regex`，动态构建查询对象
- 命令注入：shell 命令拼接用户输入
- 模板注入：SSTI（服务端模板注入）、客户端模板注入
- LDAP/XPath/GraphQL 注入
- 表达式注入：SpEL、OGNL、EL
- 反序列化：不受信任数据的 JSON.parse、pickle.loads、Java ObjectInputStream
- Protobuf/MessagePack 等二进制序列化的类型安全性（可能降低注入风险）

## 4. XSS 与输出编码

**搜索模式**: `v-html|innerHTML|dangerouslySetInnerHTML|document\.write|\.html\(|DOMPurify|sanitize|escape|encode|xss|createTextNode`

**关注点**:
- 存储型 XSS：用户/管理员输入 → 存储 → 渲染，全链路无清洗
- 反射型 XSS：URL 参数直接渲染
- DOM XSS：innerHTML、document.write、jQuery .html()
- 富文本编辑器配置：是否限制标签/属性、是否有 code 插件
- 清洗库使用：DOMPurify、sanitize-html、bleach — 是否正确配置
- CSP 头：是否存在、是否允许 unsafe-inline/unsafe-eval
- 前后端同时检查：后端是否做清洗？前端是否做清洗？还是双方都不做？

## 5. 加密与随机数

**搜索模式**: `crypto|encrypt|decrypt|hash|hmac|sign|verify|random|Math\.random|uuid|nonce|iv|salt|aes|rsa|sha|md5|bcrypt|argon|pbkdf|secret|private.?key`

**关注点**:
- 弱算法：MD5/SHA1 用于签名/密码、DES/RC4、ECB 模式
- 密钥管理：硬编码密钥/IV、密钥与密文同存、默认密钥有 fallback
- IV/Nonce：静态 IV、IV 从密钥派生、IV 重用
- 随机数：Math.random() 用于安全场景（OTP/token/密钥生成）
- 密码哈希：算法选择、参数配置（memory cost、iterations）
- 时间恒定比较：签名/MAC 验证是否用 timingSafeEqual
- 证书验证：是否禁用了 TLS 证书检查

## 6. 业务逻辑

**搜索模式**: `balance|amount|price|quantity|withdraw|deposit|transfer|refund|bonus|reward|wagering|lock|mutex|atomic|transaction|idempoten|duplicate|replay|limit|quota|inventory|stock`

**关注点**:
- 竞态条件：check-then-act 非原子操作、分布式锁实现、并发双重领取
- 资金安全：余额变更原子性、溢出/下溢、精度损失、负数处理
- 状态机：非法状态转换、被注释的状态检查、TODO 占位
- 幂等性：重复请求处理、回调重放防护
- 限额绕过：速率限制、每日限额、提现限额 — 是否可绕过
- 业务规则绕过：稽核/审核/审批流程是否可跳过
- 错误处理：错误被静默吞掉、错误检查方法用错、缺少 return

## 7. 配置与部署安全

**搜索模式**: `TODO|FIXME|HACK|TEMP|DEBUG|console\.log|debugger|process\.env|import\.meta\.env|\.env|config|secret|password|credential|default`

**关注点**:
- 硬编码凭据：密码、API Key、数据库连接字符串、私钥
- 默认凭据：README 中的示例密码是否用于生产
- 调试代码：调试后门、调试路由、调试开关未受环境变量保护
- 环境隔离：测试域名/端点泄露到生产、mock 数据残留
- 敏感日志：console.log 输出密码/token/PII
- 构建配置：console 是否被 drop、sourcemap 是否暴露
- 错误信息泄露：堆栈追踪、内部路径、SQL 错误返回给客户端
- 注释掉的安全检查：被注释的验证/检查，TODO 标记的安全功能

## 8. 文件与资源处理

**搜索模式**: `upload|download|file|path|directory|mkdir|unlink|readFile|writeFile|createReadStream|multer|formidable|busboy|blob|attachment|static|serve`

**关注点**:
- 文件上传：类型白名单、大小限制、文件名清洗、存储位置
- 路径遍历：`../` 检查、路径拼接方式
- 文件包含：动态 require/import、模板文件路径可控
- 资源限制：上传大小、请求体大小、超时设置
- 临时文件：是否及时清理、权限设置
- 下载安全：认证检查、签名 URL、防止枚举

## 9. API 安全

**搜索模式**: `rate.?limit|throttle|cors|origin|header|csrf|xsrf|token|webhook|callback|batch|bulk|pagination|cursor|offset|limit`

**关注点**:
- 速率限制：全局/端点级/用户级，实现是否正确（原子操作？）
- CORS：配置是否过于宽松、是否允许 credentials + wildcard
- CSRF：Token 机制、SameSite Cookie
- 批量操作：是否有数量限制、是否需要额外验证
- 分页：是否可请求超大页、offset 是否可为负
- 版本控制：旧版 API 是否仍可访问、是否有已知漏洞
- 响应数据：是否返回过多信息、是否泄露内部 ID/结构
- HTTP 安全头：HSTS、X-Frame-Options、X-Content-Type-Options、CSP

## 10. 前端特有

**搜索模式**: `localStorage|sessionStorage|cookie|postMessage|addEventListener.*message|iframe|window\.open|location\.href|location\.assign|document\.referrer|navigator|WebSocket|indexedDB`

**关注点**:
- 本地存储：Token/密钥/PII 存储在 localStorage（XSS 可窃取）
- postMessage：是否验证 origin、是否处理不受信任的消息
- iframe 安全：src 白名单、sandbox 属性、点击劫持
- 开放重定向：URL 参数控制跳转目标
- 第三方脚本：CDN 引入的外部 JS 是否有 SRI
- 路由守卫：认证检查、权限检查 — 仅前端还是前后端都有
- WebSocket：认证机制、消息验证、重连处理
- 依赖安全：已知漏洞的 npm/pip 包

## 11. 基础设施与通信

**搜索模式**: `amqp|rabbitmq|kafka|redis|publish|subscribe|queue|channel|grpc|rpc|discovery|register|health|internal|microservice|service\.call`

**关注点**:
- 服务间认证：内部通信是否有认证、Token 是否可伪造
- 消息队列：消息是否有签名/验证、默认凭据
- 服务发现：注册是否需要认证、可否注入假服务
- 缓存安全：Redis 认证、缓存 key 隔离（多租户）
- 健康检查/管理端点：是否暴露敏感信息、是否需要认证
- TLS/mTLS：服务间通信是否加密

## 12. 日志与审计

**搜索模式**: `log|logger|audit|trace|console|print|debug|error|warn|info|sentry|datadog|elastic|monitor`

**关注点**:
- 敏感数据泄露：密码、Token、信用卡号、PII 写入日志
- 审计完整性：关键操作是否记录、审计日志是否可被篡改
- 日志注入：用户输入直接写入日志、CRLF 注入
- Fire-and-forget：审计日志发送失败是否被忽略

## 13. 第三方集成

**搜索模式**: `callback|webhook|notify|ipn|redirect_uri|return_url|vendor|provider|adapter|sdk|api\..*\.(com|io|net)|integration`

**关注点**:
- 回调验证：签名验证、IP 白名单、时间戳检查
- 重放防护：Nonce、幂等键、状态机
- 凭据管理：第三方 API Key/Secret 的存储方式
- 错误处理：第三方失败时的降级/回滚
- 硬编码端点：测试/沙箱 URL 残留在生产

---

## 扫描策略选择指南

根据项目类型快速选择优先维度：

| 项目类型 | 优先维度 |
|---------|---------|
| Web 后端 API | 1-3, 6-7, 9, 11-12 |
| Web 前端 SPA | 4, 7, 10 |
| 管理后台 | 2, 4, 6-7, 10 |
| 支付/金融 | 1-3, 5-6, 9, 13 |
| 移动应用后端 | 1-3, 5, 8-9 |
| 微服务架构 | 1-2, 7, 9, 11-12 |
| 全栈 Monorepo | 全部 |
