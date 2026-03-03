require('dotenv').config();

/**
 * 从环境变量加载运行时配置
 * @param {Object} overrides - 运行时覆盖配置（用于 webhook 动态传参）
 */
function loadRuntimeConfig(overrides = {}) {
    const pick = (overrideValue, envValue, fallback = undefined) => {
        if (overrideValue !== undefined && overrideValue !== null && overrideValue !== '') return overrideValue;
        if (envValue !== undefined && envValue !== null && envValue !== '') return envValue;
        return fallback;
    };

    const toBoolean = (value, defaultValue = false) => {
        if (value === undefined || value === null || value === '') return defaultValue;
        if (typeof value === 'boolean') return value;
        return String(value).toLowerCase() === 'true';
    };

    // GitLab 配置
    const GITLAB_TOKEN = pick(overrides.gitlabToken, process.env.GITLAB_TOKEN);
    const CI_PROJECT_ID = pick(overrides.projectId, process.env.CI_PROJECT_ID);
    const CI_MERGE_REQUEST_IID = pick(overrides.mergeRequestIid, process.env.CI_MERGE_REQUEST_IID);
    const CI_API_V4_URL = pick(overrides.gitlabApiUrl, process.env.CI_API_V4_URL); // e.g., https://gitlab.com/api/v4

    // AI 模型配置
    const OPENAI_API_KEY = pick(overrides.aiApiKey, process.env.OPENAI_API_KEY);
    const OPENAI_BASE_URL = pick(
        overrides.aiApiUrl,
        process.env.OPENAI_BASE_URL,
        'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );
    const REVIEW_MODEL = pick(overrides.aiModel, process.env.REVIEW_MODEL, 'qwen3-coder-plus');

    // 审查配置
    const MAX_PARALLEL = parseInt(pick(overrides.maxParallel, process.env.MAX_PARALLEL, '3'), 10);
    const ISSUE_LIMIT = parseInt(pick(overrides.issueLimit, process.env.ISSUE_LIMIT, '10'), 10);
    const REVIEW_MODE = pick(overrides.reviewMode, process.env.REVIEW_MODE, 'report'); // 'report' or 'inline'

    // 功能开关
    const ENABLE_AST = toBoolean(pick(overrides.enableAst, process.env.ENABLE_AST), true);
    const DRY_RUN = toBoolean(pick(overrides.dryRun, process.env.DRY_RUN), false);

    // Diff 大小限制（防止超大文件消耗过多 token）
    const MAX_DIFF_LINES = parseInt(pick(overrides.maxDiffLines, process.env.MAX_DIFF_LINES, '500'), 10);
    const MAX_DIFF_CHARS = parseInt(pick(overrides.maxDiffChars, process.env.MAX_DIFF_CHARS, '50000'), 10);

    // AST 配置
    const AST_MAX_SNIPPET_LENGTH = parseInt(
        pick(overrides.astMaxSnippetLength, process.env.AST_MAX_SNIPPET_LENGTH, '10000'),
        10
    );
    const AST_MAX_BLOCK_SIZE_LINES = parseInt(
        pick(overrides.astMaxBlockSizeLines, process.env.AST_MAX_BLOCK_SIZE_LINES, '150'),
        10
    );
    const AST_MAX_DEPTH = parseInt(pick(overrides.astMaxDepth, process.env.AST_MAX_DEPTH, '60'), 10);
    const AST_TIMEOUT_MS = parseInt(pick(overrides.astTimeoutMs, process.env.AST_TIMEOUT_MS, '8000'), 10);

    // 路径配置
    const PROJECT_ROOT = pick(overrides.projectRoot, process.env.PROJECT_ROOT, process.cwd());
    const GUIDELINES_FILE = pick(overrides.guidelinesFile, process.env.GUIDELINES_FILE, 'coding_guidelines.yaml');

    // Webhook 配置
    const WEBHOOK_PORT = parseInt(pick(overrides.webhookPort, process.env.WEBHOOK_PORT, '8787'), 10);
    const GITLAB_WEBHOOK_SECRET = pick(overrides.webhookSecret, process.env.GITLAB_WEBHOOK_SECRET, '');
    const WEBHOOK_ALLOWED_ACTIONS = String(
        // 默认包含 merge，兼容“点击合并后再触发 webhook”的场景
        pick(overrides.webhookAllowedActions, process.env.WEBHOOK_ALLOWED_ACTIONS, 'open,update,reopen,merge')
    )
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);

    // 验证必须环境变量
    const isLocalDebug = toBoolean(pick(overrides.isLocalDebug, process.env.IS_LOCAL_DEBUG), false);
    // webhook 模式下 projectId / mergeRequestIid 从 payload 动态传入，可以跳过静态校验
    const skipProjectContextValidation = toBoolean(overrides.skipProjectContextValidation, false);

    // demo / 单元测试场景可跳过凭据校验，避免阻塞本地联调
    const skipCredentialValidation = toBoolean(overrides.skipCredentialValidation, false);

    const required = skipCredentialValidation
        ? {}
        : (isLocalDebug || skipProjectContextValidation)
            ? { GITLAB_TOKEN, CI_API_V4_URL, OPENAI_API_KEY }
            : { GITLAB_TOKEN, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, CI_API_V4_URL, OPENAI_API_KEY };

    for (const [key, value] of Object.entries(required)) {
        if (!value) {
            const hint = (isLocalDebug || skipProjectContextValidation)
                ? '\n提示: 请检查本地环境变量或 webhook 服务配置'
                : '\n提示: 请检查 GitLab CI/CD 变量配置';
            throw new Error(`缺少必需的环境变量: ${key}${hint}`);
        }
    }

    // 规范化 GitLab API URL
    const gitlabApiUrl = CI_API_V4_URL
        ? (CI_API_V4_URL.endsWith('/') ? CI_API_V4_URL.slice(0, -1) : CI_API_V4_URL)
        : '';

    return {
        // GitLab
        gitlabToken: GITLAB_TOKEN,
        projectId: CI_PROJECT_ID,
        mergeRequestIid: CI_MERGE_REQUEST_IID,
        gitlabApiUrl,

        // AI 模型
        aiApiKey: OPENAI_API_KEY,
        aiApiUrl: OPENAI_BASE_URL,
        aiModel: REVIEW_MODEL,

        // 审查参数
        maxParallel: MAX_PARALLEL,
        issueLimit: ISSUE_LIMIT,
        reviewMode: REVIEW_MODE,

        // 功能开关
        enableAst: ENABLE_AST,
        dryRun: DRY_RUN,

        // Diff 限制
        maxDiffLines: MAX_DIFF_LINES,
        maxDiffChars: MAX_DIFF_CHARS,

        // AST 配置
        astConfig: {
            maxSnippetLength: AST_MAX_SNIPPET_LENGTH,
            maxBlockSizeLines: AST_MAX_BLOCK_SIZE_LINES,
            maxDepth: AST_MAX_DEPTH,
            timeoutMs: AST_TIMEOUT_MS,
        },

        // 路径
        projectRoot: PROJECT_ROOT,
        guidelinesFile: GUIDELINES_FILE,

        // Webhook
        webhook: {
            port: WEBHOOK_PORT,
            secretToken: GITLAB_WEBHOOK_SECRET,
            allowedActions: WEBHOOK_ALLOWED_ACTIONS,
        },
    };
}

module.exports = {
    loadRuntimeConfig,
};
