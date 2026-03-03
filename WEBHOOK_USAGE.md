# GitLab Webhook 接口说明

## 目标
在保留原有 `CI 直跑` 流程的前提下，新增一个 webhook 入口，复用原有审查主流程（`runReview`），实现最小改动接入。

## 新增接口
- 方法: `POST`
- 路径: `/webhook/gitlab`
- 健康检查: `GET /health`

## 调用规则
1. 事件类型必须是 `merge_request`
- 字段: `object_kind === "merge_request"`
- 不满足时返回 `202`，并忽略事件。

2. action 必须在允许列表中
- 字段: `object_attributes.action`
- 默认允许: `open,update,reopen`
- 可通过环境变量 `WEBHOOK_ALLOWED_ACTIONS` 覆盖，例如:
  - `WEBHOOK_ALLOWED_ACTIONS=open,update,reopen,approved`

3. 必须提供 MR 定位信息
- `project.id`
- `object_attributes.iid`
- 缺失时返回 `400`。

4. 可选 token 校验
- 若配置 `GITLAB_WEBHOOK_SECRET`，则必须在 Header 传:
  - `X-Gitlab-Token: <GITLAB_WEBHOOK_SECRET>`
- 校验失败返回 `401`。

5. 响应策略
- 接口先返回 `202 accepted`，后台异步执行审查，避免 webhook 超时。
- 返回示例:
```json
{
  "message": "accepted",
  "traceId": "123-456-1739250000000",
  "projectId": "123",
  "mergeRequestIid": "456",
  "action": "update",
  "demoMode": false
}
```

## 运行时参数来源
webhook 收到事件后，会从 payload 中提取:
- `projectId = project.id`
- `mergeRequestIid = object_attributes.iid`

然后将这两个参数作为 `configOverrides` 传入 `runReview`，其余配置继续复用 `.env`。

## 本地 Demo Mock

### 1. mock 数据文件
- `mock/gitlab_webhook_merge_request.json`

### 2. 启动 webhook 服务
```bash
pnpm run webhook
```

### 3. 发送 mock 请求
```bash
pnpm run demo:webhook
```

也可指定自定义 mock 文件:
```bash
node debug_webhook.js ./mock/gitlab_webhook_merge_request.json
```

### 4. 纯本地演示模式（不依赖真实 GitLab/AI 凭据）
```bash
# Windows PowerShell
$env:WEBHOOK_DEMO_MODE='true'
pnpm run webhook
```

`WEBHOOK_DEMO_MODE=true` 时，接口仍会完整校验 payload 规则并返回 accepted，但不会触发实际审查调用。

## 可选配置
- `WEBHOOK_PORT`:
  - 默认 `80`
- `GITLAB_WEBHOOK_SECRET`:
  - webhook 签名密钥（可选，建议生产开启）
- `WEBHOOK_ALLOWED_ACTIONS`:
  - 允许触发审查的 action 列表，逗号分隔
- `WEBHOOK_PROJECT_ROOT_MAP`:
  - 可选 JSON，用于不同项目映射本地 AST 根目录
  - 示例: `{"123":"E:/repo/project-a","456":"E:/repo/project-b"}`

## 与原流程关系
- 原有 `pnpm run start`（CI 直跑）保持不变。
- 新增 `pnpm run webhook` 仅增加一个入口，不改变审查核心链路。
