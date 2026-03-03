const express = require('express');
const { runReview } = require('./main');
const { loadRuntimeConfig } = require('./config');

/**
 * 解析布尔配置
 */
function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

/**
 * 获取 webhook 服务基础配置
 * - webhook 场景下 projectId/MR IID 由 payload 提供，因此跳过静态上下文校验
 * - demo 模式下允许跳过凭据校验，便于本地 mock 联调
 */
function getWebhookBaseConfig() {
    const isDemoMode = toBoolean(process.env.WEBHOOK_DEMO_MODE, false);
    return loadRuntimeConfig({
        skipProjectContextValidation: true,
        skipCredentialValidation: isDemoMode,
    });
}

/**
 * 校验 GitLab webhook token（配置了密钥才强校验）
 */
function validateWebhookToken(req, secretToken) {
    if (!secretToken) return true;
    const token = req.get('x-gitlab-token') || '';
    return token === secretToken;
}

/**
 * 统一 action 文本，避免大小写或空格导致误判
 */
function normalizeAction(action) {
    const normalized = String(action || '').trim().toLowerCase();
    // 兼容部分系统/中间层可能传递 merged
    if (normalized === 'merged') return 'merge';
    return normalized;
}

/**
 * 将 action 列表标准化为小写数组
 */
function normalizeAllowedActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.map(normalizeAction).filter(Boolean);
}

/**
 * 安全序列化日志对象，避免循环引用导致日志中断
 */
function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch (error) {
        return JSON.stringify({ stringifyError: error.message });
    }
}

/**
 * 从 payload 解析审查上下文
 */
function parseMergeRequestPayload(payload, allowedActions, traceId = '-') {
    const normalizedAllowedActions = normalizeAllowedActions(allowedActions);

    if (!payload || payload.object_kind !== 'merge_request') {
        console.log(`[WEBHOOK][FILTER] ignore non merge_request: ${safeJson({
            traceId,
            object_kind: payload?.object_kind,
            event_type: payload?.event_type,
        })}`);
        return {
            accepted: false,
            status: 202,
            body: { message: 'ignore: only merge_request webhook is supported' },
        };
    }

    const actionRaw = payload.object_attributes?.action;
    if (!actionRaw) {
        console.log(`[WEBHOOK][FILTER] reject missing action: ${safeJson({
            traceId,
            object_kind: payload.object_kind,
            event_type: payload.event_type,
        })}`);
        return {
            accepted: false,
            status: 400,
            body: { message: 'invalid payload: object_attributes.action is required' },
        };
    }

    const action = normalizeAction(actionRaw);

    if (!normalizedAllowedActions.includes(action)) {
        console.log(`[WEBHOOK][FILTER] ignore action not allowed: ${safeJson({
            traceId,
            actionRaw,
            actionNormalized: action,
            allowedActions: normalizedAllowedActions,
            envAllowedActions: process.env.WEBHOOK_ALLOWED_ACTIONS || '(default: open,update,reopen,merge)',
        })}`);
        return {
            accepted: false,
            status: 202,
            body: {
                message: 'ignore: action is not allowed',
                action,
                allowedActions: normalizedAllowedActions,
            },
        };
    }

    const projectId = payload.project?.id;
    const mergeRequestIid = payload.object_attributes?.iid;

    if (!projectId || !mergeRequestIid) {
        console.log(`[WEBHOOK][FILTER] reject missing project/id: ${safeJson({
            traceId,
            projectId,
            mergeRequestIid,
        })}`);
        return {
            accepted: false,
            status: 400,
            body: { message: 'invalid payload: project.id and object_attributes.iid are required' },
        };
    }

    return {
        accepted: true,
        action,
        projectId: String(projectId),
        mergeRequestIid: String(mergeRequestIid),
        source: payload,
    };
}

/**
 * 按 projectId 解析 AST 项目路径
 * 支持环境变量 WEBHOOK_PROJECT_ROOT_MAP（JSON），示例：{"123":"E:/repo/project-a"}
 */
function resolveProjectRoot(projectId) {
    const mapRaw = process.env.WEBHOOK_PROJECT_ROOT_MAP;
    if (!mapRaw) {
        return process.env.PROJECT_ROOT || process.cwd();
    }

    try {
        const projectRootMap = JSON.parse(mapRaw);
        const mappedPath = projectRootMap[String(projectId)];
        if (mappedPath) {
            return mappedPath;
        }
    } catch (error) {
        console.warn('WEBHOOK_PROJECT_ROOT_MAP 解析失败，将回退到 PROJECT_ROOT。');
    }

    return process.env.PROJECT_ROOT || process.cwd();
}

/**
 * 创建 webhook app
 */
function createWebhookApp() {
    const app = express();

    app.use(express.json({ limit: '2mb' }));

    app.get('/health', (req, res) => {
        res.json({ ok: true, service: 'ai-code-review-webhook' });
    });

    // 新增 GitLab webhook 接口
    app.post('/webhook/gitlab', (req, res) => {
        // 请求级追踪 ID，方便串联日志
        const requestTraceId = req.get('x-gitlab-event-uuid') || `req-${Date.now()}`;

        // 请求入口摘要日志（只打关键字段，避免日志过大）
        console.log(`[WEBHOOK][REQUEST] ${safeJson({
            traceId: requestTraceId,
            method: req.method,
            path: req.originalUrl,
            object_kind: req.body?.object_kind,
            event_type: req.body?.event_type,
            action: req.body?.object_attributes?.action,
            project_id: req.body?.project?.id,
            mr_iid: req.body?.object_attributes?.iid,
            hasToken: Boolean(req.get('x-gitlab-token')),
            gitlabEvent: req.get('x-gitlab-event') || '',
            contentType: req.get('content-type') || '',
        })}`);

        console.log("🚀 ~ createWebhookApp ~ req:", JSON.stringify(req.body));
        // console.log("🚀 ~ createWebhookApp ~ req.body.params:", req.body.params)
        let baseConfig;
        try {
            baseConfig = getWebhookBaseConfig();
            console.log(`[WEBHOOK][CONFIG] ${safeJson({
                traceId: requestTraceId,
                allowedActions: normalizeAllowedActions(baseConfig.webhook.allowedActions),
                envAllowedActions: process.env.WEBHOOK_ALLOWED_ACTIONS || '(default: open,update,reopen,merge)',
                hasSecretToken: Boolean(baseConfig.webhook.secretToken),
                webhookPort: baseConfig.webhook.port,
            })}`);
        } catch (error) {
            console.error(`[WEBHOOK][CONFIG] load failed: ${safeJson({
                traceId: requestTraceId,
                error: error.message || String(error),
            })}`);
            res.status(500).json({ message: 'server config error', error: error.message });
            return;
        }

        if (!validateWebhookToken(req, baseConfig.webhook.secretToken)) {
            console.warn(`[WEBHOOK][AUTH] invalid webhook token: ${safeJson({
                traceId: requestTraceId,
                hasProvidedToken: Boolean(req.get('x-gitlab-token')),
                hasSecretToken: Boolean(baseConfig.webhook.secretToken),
            })}`);
            res.status(401).json({ message: 'invalid webhook token' });
            return;
        }

        const parsed = parseMergeRequestPayload(req.body, baseConfig.webhook.allowedActions, requestTraceId);
        if (!parsed.accepted) {
            console.log(`[WEBHOOK][RESPONSE] rejected: ${safeJson({
                traceId: requestTraceId,
                status: parsed.status,
                body: parsed.body,
            })}`);
            res.status(parsed.status).json(parsed.body);
            return;
        }

        const traceId = `${parsed.projectId}-${parsed.mergeRequestIid}-${Date.now()}`;
        const isDemoMode = toBoolean(process.env.WEBHOOK_DEMO_MODE, false);

        // 先快速响应 webhook，实际审查在后台执行，避免上游超时
        res.status(202).json({
            message: 'accepted',
            traceId,
            projectId: parsed.projectId,
            mergeRequestIid: parsed.mergeRequestIid,
            action: parsed.action,
            demoMode: isDemoMode,
        });
        console.log(`[WEBHOOK][RESPONSE] accepted: ${safeJson({
            traceId,
            requestTraceId,
            projectId: parsed.projectId,
            mergeRequestIid: parsed.mergeRequestIid,
            action: parsed.action,
            demoMode: isDemoMode,
        })}`);

        if (isDemoMode) {
            console.log(`[WEBHOOK][DEMO] accepted traceId=${traceId}, project=${parsed.projectId}, mr=${parsed.mergeRequestIid}`);
            return;
        }

        const projectRoot = resolveProjectRoot(parsed.projectId);

        // 异步执行审查，避免阻塞 webhook 返回
        setImmediate(async () => {
            const startAt = Date.now();
            try {
                console.log(`[WEBHOOK][REVIEW] start: ${safeJson({
                    traceId,
                    projectId: parsed.projectId,
                    mergeRequestIid: parsed.mergeRequestIid,
                    projectRoot,
                })}`);
                await runReview({
                    configOverrides: {
                        projectId: parsed.projectId,
                        mergeRequestIid: parsed.mergeRequestIid,
                        projectRoot,
                    },
                });
                console.log(`[WEBHOOK][REVIEW] finished: ${safeJson({
                    traceId,
                    durationMs: Date.now() - startAt,
                })}`);
            } catch (error) {
                console.error(`[WEBHOOK][REVIEW] failed: ${safeJson({
                    traceId,
                    durationMs: Date.now() - startAt,
                    error: error.message || String(error),
                })}`);
            }
        });
    });

    // JSON 解析失败兜底
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') {
            console.warn(`[WEBHOOK][REQUEST] invalid json payload: ${safeJson({
                method: req.method,
                path: req.originalUrl,
                contentType: req.get('content-type') || '',
                contentLength: req.get('content-length') || '',
            })}`);
            res.status(400).json({ message: 'invalid json payload' });
            return;
        }
        next(err);
    });

    return app;
}

/**
 * 启动 webhook 服务
 */
function startWebhookServer() {
    const baseConfig = getWebhookBaseConfig();
    const app = createWebhookApp();
    const port = baseConfig.webhook.port;

    // 启动阶段打印关键配置，便于核对环境变量是否生效
    console.log(`[WEBHOOK][BOOT] ${safeJson({
        port,
        allowedActions: normalizeAllowedActions(baseConfig.webhook.allowedActions),
        envAllowedActions: process.env.WEBHOOK_ALLOWED_ACTIONS || '(default: open,update,reopen,merge)',
        hasSecretToken: Boolean(baseConfig.webhook.secretToken),
        demoMode: toBoolean(process.env.WEBHOOK_DEMO_MODE, false),
    })}`);

    app.listen(port, () => {
        console.log(`Webhook server started on port ${port}`);
        console.log('Endpoint: POST /webhook/gitlab');
    });
}

if (require.main === module) {
    startWebhookServer();
}

module.exports = {
    createWebhookApp,
    startWebhookServer,
    parseMergeRequestPayload,
    resolveProjectRoot,
};
