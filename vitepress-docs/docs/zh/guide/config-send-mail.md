
# 配置发送邮件

::: tip 推荐方案
推荐使用 Cloudflare `send_email` binding 作为默认发信通道。绑定 `SEND_MAIL` 并完成 Email Routing onboarding 后，即可直接向任意外部地址发信。

Workers Paid 每月含 3,000 封，超出部分 $0.35 / 1000 封。
:::

## 发信通道优先级

每次 `/api/send_mail` 请求按如下顺序匹配通道，**命中即发送**：

| 顺序 | 条件 | 通道 | 扣 balance |
|------|------|------|-----------|
| 1 | `SEND_MAIL` 已绑定 **且** 收件人在 `verifiedAddressList` | Cloudflare binding（兼容模式） | 否 |
| 2 | `RESEND_TOKEN` 或 `RESEND_TOKEN_<DOMAIN>` 已配置 | Resend API | 是 |
| 3 | `SMTP_CONFIG` 含当前域名配置 | worker-mailer SMTP | 是 |
| 4 | `SEND_MAIL` 已绑定（以上均未命中） | **Cloudflare binding（推荐主通道）** | 是 |
| — | 以上均未命中 | 抛错 | — |

> [!NOTE]
> binding 发信失败会直接报错。

## 多发信服务商与自动切换（`MAIL_PROVIDERS`）

配置 `MAIL_PROVIDERS` 后，上表第 2～4 层改为按优先级依次尝试多个服务商（第 1 层已验证地址列表不变）：

- `priority` 越小越优先，相同时按配置顺序
- 额度用尽、限流、5xx、网络超时、密钥或域名未验证：自动换下一家
- 收件人地址无效等**永久错误**：直接报错，不再换服务商，避免同一封信被多家重复发送
- 达到本地 `dailyLimit` / `monthlyLimit` 的服务商会被跳过（按 UTC 日、月计数，`0` 或不填表示不限）

```json
[
  { "name": "resend", "type": "resend", "priority": 1, "apiKey": "re_xxx", "dailyLimit": 100, "monthlyLimit": 3000 },
  { "name": "brevo", "type": "brevo", "priority": 2, "apiKey": "xkeysib-xxx", "dailyLimit": 300 },
  { "name": "backup-smtp", "type": "smtp", "priority": 3, "domains": ["mail.example.com"],
    "smtp": { "host": "smtp.example.com", "port": 465, "secure": true, "authType": ["plain", "login"],
              "credentials": { "username": "user", "password": "pass" } } }
]
```

| 字段 | 说明 |
|------|------|
| `name` | 唯一名称，用于统计与日志 |
| `type` | `resend`（API）、`brevo`（API v3）、`smtp`（worker-mailer）、`binding`（Cloudflare `SEND_MAIL`） |
| `priority` | 优先级，越小越先用 |
| `enabled` | 设为 `false` 临时停用 |
| `domains` | 仅对这些发件域名生效，留空表示所有域名 |
| `dailyLimit` / `monthlyLimit` | 本地额度上限，达到后跳过 |
| `apiKey` | `resend`、`brevo` 必填 |
| `baseUrl` | 可选，覆盖 API 地址（自建代理或测试） |
| `smtp` | `smtp` 必填，格式同 `SMTP_CONFIG` 的单个域名配置 |

建议以 secret 方式保存：`wrangler secret put MAIL_PROVIDERS`。

每次实际尝试都会写入 D1 表 `mail_provider_log`，成功次数按服务商累计到 `mail_provider_usage`（首次使用自动建表，也可执行 `db/2026-10-27-mail-providers.sql`）。管理接口：

- `GET /admin/mail_providers?remote=true`：各服务商配置（密钥已脱敏）、本地日/月用量；`remote=true` 时附带服务商侧余量（Brevo 查询 `/v3/account`，Resend 读取最近一次发信的 `x-resend-*-quota` 响应头）
- `GET /admin/mail_providers/logs?limit=20&offset=0&provider=resend`：发信尝试记录

## 使用 Cloudflare `send_email` binding（推荐）

仅 CLI 部署时使用，在 `wrangler.toml` 中添加：

```toml
# 通过 Cloudflare send_email binding 发送邮件
send_email = [
   { name = "SEND_MAIL" },
]
```

> [!warning] 重要
> 绑定名必须为 `SEND_MAIL`，与 Cloudflare 官方文档示例中的 `SEND_EMAIL` 不同。

完成下列步骤后即可直接向任意外部地址发信：

1. 在 Cloudflare Dashboard 给对应域名开启 Email Routing 并完成 onboarding
2. `wrangler.toml` 添加上述 `send_email` 绑定
3. 部署 Worker

无需配置任何额外的 env var。

## 使用 Resend 发送邮件

注册 `https://resend.com/domains` 根据提示添加 DNS 记录,

> [!WARNING] Cloudflare 上 DNS 记录的代理状态
> Resend 域名验证的 CNAME 记录**必须设置为 仅 DNS**（灰云），在
> Cloudflare DNS 控制面板中代理（橙云）记录会阻止 Resend
> 完成验证，且一次失败的尝试可能需要数小时才能重试。
> 参见 [#515](https://github.com/dreamhunter2333/cloudflare_temp_email/issues/515)。

`API KEYS` 页面创建 `api key`

然后执行下面的命令，将 `RESEND_TOKEN` 添加到 secrets 中

> [!NOTE]
> 如果你觉得麻烦，也可以直接明文放在 `wrangler.toml` 中 `[vars]` 下面，但是不推荐这样做

如果你是通过 UI 部署的，可以在 Cloudflare 的 UI 界面中添加到 `Variables and Secrets` 下面

```bash
# 切换到 worker 目录
cd worker
wrangler secret put RESEND_TOKEN
```

如果你有多个域名，对应不同的 `api key`，可以在 `wrangler.toml` 中添加多个 secret, 名称为 `RESEND_TOKEN_` + `<. 换成 _ 的 大写域名>`,例如

```bash
wrangler secret put RESEND_TOKEN_XXX_COM
wrangler secret put RESEND_TOKEN_DREAMHUNTER2333_XYZ
```

## 使用 SMTP 发送邮件

`SMTP_CONFIG` 的格式如下，**key 必须是你自己的发信域名**，value 为 SMTP 配置。

SMTP 配置格式详情可以参考 [zou-yu/worker-mailer](https://github.com/zou-yu/worker-mailer/blob/main/README_zh-CN.md)

> [!warning] 重要
> JSON 中的 key（如下面示例中的 `your-domain.com`）必须替换为**你自己的域名**，即 `DOMAINS` 变量中配置的域名。
> 这是最常见的配置错误之一，请勿直接复制示例中的域名。

```json
{
    "your-domain.com": {
        "host": "smtp.example.com",
        "port": 465,
        "secure": true,
        "authType": [
            "plain",
            "login"
        ],
        "credentials": {
            "username": "your-smtp-username",
            "password": "your-smtp-password"
        }
    }
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| key（如 `your-domain.com`） | 你的发信域名，必须与 `DOMAINS` 中配置的域名一致 |
| `host` | SMTP 服务器地址，如 `smtp.mailgun.org`、`smtp.gmail.com` 或你自建的 SMTP 服务器地址 |
| `port` | SMTP 端口，通常 `465`（SSL）或 `587`（STARTTLS） |
| `secure` | 是否使用 SSL/TLS，端口 465 时设为 `true`，端口 587 时设为 `false` |
| `authType` | 认证方式，一般使用 `["plain", "login"]` |
| `credentials.username` | SMTP 服务器的登录用户名 |
| `credentials.password` | SMTP 服务器的登录密码 |

如果你有**多个域名**使用不同的 SMTP 服务，在同一个 JSON 中添加多个 key 即可：

```json
{
    "domain-a.com": {
        "host": "smtp.mailgun.org",
        "port": 465,
        "secure": true,
        "authType": ["plain", "login"],
        "credentials": { "username": "user@domain-a.com", "password": "xxx" }
    },
    "domain-b.com": {
        "host": "smtp.gmail.com",
        "port": 465,
        "secure": true,
        "authType": ["plain", "login"],
        "credentials": { "username": "user@gmail.com", "password": "app-password" }
    }
}
```

然后执行下面的命令，将 `SMTP_CONFIG` 添加到 secrets 中

> [!NOTE]
> 如果你觉得麻烦，也可以直接明文放在 `wrangler.toml` 中 `[vars]` 下面，但是不推荐这样做

如果你是通过 UI 部署的，可以在 Cloudflare 的 UI 界面中添加到 `Variables and Secrets` 下面

```bash
# 切换到 worker 目录
cd worker
wrangler secret put SMTP_CONFIG
```

## 用户账号、邮箱、邮箱地址与发信权限

这些概念相互关联，但不是同一个对象：

| 概念 | 说明 |
|------|------|
| 用户账号 | 用于登录用户中心，可绑定和管理多个邮箱；用户账号的用户邮箱本身不等于用于收发信的邮箱地址 |
| 邮箱 | 包含收件箱、发件箱、发信能力和邮箱设置的业务对象 |
| 邮箱地址 | 标识邮箱的具体值，例如 `name@example.com`；当前邮箱由该地址的 Address JWT 认证 |
| 发信权限与额度 | `address_sender` 中的权限和额度以**邮箱地址**为单位独立管理；`NO_LIMIT_SEND_ROLE` 配置的用户角色可以绕过地址额度检查 |

因此，同一用户账号绑定的多个邮箱地址不会共享发信权限或余额。为某个地址申请发信权限时：

1. 先在前端切换到需要发信的邮箱
2. 打开「发送邮件」页
3. 点击「申请权限」

申请只作用于当时选中的邮箱地址。切换到另一个地址后，需要查看该地址自己的额度，并在需要时单独申请。邮箱地址不必绑定用户账号也可以独立持有发信权限。

## 发信余额机制

邮箱地址发送邮件需要有该地址的发信余额。余额机制如下：

1. **自动初始化默认额度**：当 `DEFAULT_SEND_BALANCE > 0` 时，用户打开前端发信页或第一次调用发信接口时，系统会自动为该地址初始化默认额度
2. **手动申请**：如果 `DEFAULT_SEND_BALANCE = 0`，使用者可以在前端切换到目标邮箱地址并点击「申请权限」，为当前地址创建待管理员处理的发信权限记录
3. **无限制发送**：以下方式可以跳过余额检查：
   - 在管理后台将邮箱地址加入「无限制发送地址列表」
   - 配置 `NO_LIMIT_SEND_ROLE` 环境变量，指定可以无限发送的用户角色

> [!NOTE]
> `DEFAULT_SEND_BALANCE` 仅在地址尚无 `address_sender` 记录时自动插入初始额度（`ON CONFLICT DO NOTHING`），已有记录（包括管理员禁用或手动设置的行）一律保持原样，runtime 不会修改；历史异常或被禁用的地址需由管理员在后台手动启用并设置余额。
>
> 第 1 层 `verifiedAddressList` 命中时不扣余额，但同样计入发信额度；第 2/3/4 层统一扣 balance。
>
> 发信额度对**全部**发信渠道生效，admin 发信接口也会一起计入。
>
> 每日和每月额度按 **UTC** 时间窗口计算。
>
> 当前额度实现属于 **soft guard**，适合日常额度控制；在数据库异常或高并发场景下，它不适合作为绝对严格的成本硬闸。

## 给 Cloudflare 上已认证的转发邮箱发送邮件

适合未完成 Email Routing onboarding 的域名，或 Workers 免费版。

只有收件人在管理后台的 `已验证地址列表` 中时，才会通过 `SEND_MAIL` binding 发信。
