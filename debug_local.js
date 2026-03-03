// debug_local.js

/**
 * 本地调试脚本
 * 
 * 本脚本用于在本地环境中调试 AI 代码审查工具。
 * 它会从 .env.local 文件加载配置，并模拟 GitLab CI 环境变量。
 * 
 * 快速开始:
 * 1. 复制并配置环境文件:
 *    copy .env.example .env.local
 *    编辑 .env.local，填入真实的 GITLAB_TOKEN 和 OPENAI_API_KEY
 * 
 * 2. 修改下方配置区的项目信息:
 *    - GITLAB_PROJECT_ID: 你的 GitLab 项目 ID
 *    - GITLAB_MR_IID: 要审查的 Merge Request IID
 *    - TARGET_PROJECT_PATH: 目标项目路径（用于 AST 分析）
 * 
 * 3. 运行调试:
 *    pnpm run dev
 *    或
 *    node debug_local.js
 * 
 * 调试方式:
 * - VS Code: 按 F5 启动调试器
 * - Chrome DevTools: node --inspect-brk debug_local.js
 */

const path = require('path');
const fs = require('fs');

// 优先加载 .env.local，如果不存在则尝试 .env
const envLocalPath = path.join(__dirname, '.env.local');
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envLocalPath)) {
    console.log('📝 加载配置文件: .env.local');
    require('dotenv').config({ path: envLocalPath });
} else if (fs.existsSync(envPath)) {
    console.log('📝 加载配置文件: .env');
    require('dotenv').config({ path: envPath });
} else {
    console.error('❌ 找不到配置文件！');
    console.error('请创建 .env.local 文件并填入必需的配置项。');
    console.error('提示: 可以复制 .env.example 作为模板');
    process.exit(1);
}

const { runReview } = require('./src/main');

// --- ⚙️ 配置区：请修改为你需要调试的目标 ---
const GITLAB_PROJECT_ID = "your_project_id"; // 👈 修改这里: 你的 GitLab 项目 ID
const GITLAB_MR_IID = "your_mr_id";       // 👈 修改这里: 你想审查的 Merge Request IID (纯数字)
const TARGET_PROJECT_PATH = "../your-project/"; // 👈 修改这里: 目标项目的相对路径或绝对路径
// ----------------------------------------------------

async function debug() {
    console.log("--- 🚀 开始本地调试模式 ---\n");

    // 检查必需的环境变量
    const requiredEnvVars = ['GITLAB_TOKEN', 'OPENAI_API_KEY', 'CI_API_V4_URL'];
    const missingVars = requiredEnvVars.filter(key => !process.env[key]);

    if (missingVars.length > 0) {
        console.error("🚨 错误: 以下环境变量未在 .env.local 中设置:");
        missingVars.forEach(key => console.error(`   - ${key}`));
        console.error("\n请编辑 .env.local 文件并填入正确的值。");
        return;
    }

    // 检查是否使用了占位符
    const placeholders = [
        { key: 'GITLAB_TOKEN', pattern: /your.*gitlab.*token/i },
        { key: 'OPENAI_API_KEY', pattern: /your.*aliyun.*api.*key/i }
    ];

    const hasPlaceholder = placeholders.find(({ key, pattern }) =>
        pattern.test(process.env[key])
    );

    if (hasPlaceholder) {
        console.error(`🚨 错误: ${hasPlaceholder.key} 仍在使用占位符！`);
        console.error("请在 .env.local 中填入真实的配置值。");
        return;
    }

    // 检查脚本配置
    if (GITLAB_PROJECT_ID === "your_project_id" || GITLAB_MR_IID === "your_mr_id") {
        console.error("🚨 错误: 请在此脚本中修改以下配置:");
        console.error("   - GITLAB_PROJECT_ID (当前: your_project_id)");
        console.error("   - GITLAB_MR_IID (当前: your_mr_id)");
        return;
    }

    // 设置本地调试标志（供 config.js 识别）
    process.env.IS_LOCAL_DEBUG = 'true';

    // 模拟 GitLab CI 提供的环境变量
    process.env.CI_PROJECT_ID = GITLAB_PROJECT_ID;
    process.env.CI_MERGE_REQUEST_IID = GITLAB_MR_IID;

    // 设置项目根目录（用于 AST 功能定位文件）
    const resolvedProjectPath = path.resolve(__dirname, TARGET_PROJECT_PATH);
    process.env.PROJECT_ROOT = resolvedProjectPath;

    console.log(`📋 配置信息:`);
    console.log(`   项目 ID: ${process.env.CI_PROJECT_ID}`);
    console.log(`   Merge Request IID: ${process.env.CI_MERGE_REQUEST_IID}`);
    console.log(`   项目根目录: ${resolvedProjectPath}`);
    console.log(`   GitLab API: ${process.env.CI_API_V4_URL}`);
    console.log(`   AI 模型: ${process.env.REVIEW_MODEL || 'qwen3-coder-plus'}\n`);

    // 调用核心审查函数
    await runReview();

    console.log("\n--- ✅ 本地调试结束 ---");
}

debug().catch(error => {
    console.error("本地调试过程中发生错误:", error);
});
