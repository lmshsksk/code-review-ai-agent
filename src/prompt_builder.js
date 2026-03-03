const fs = require('fs/promises');
const path = require('path');

// 缓存 system prompt 模板，避免重复读取
let systemPromptTemplate = null;

/**
 * 加载 System Prompt 模板
 */
async function loadSystemPromptTemplate() {
    if (!systemPromptTemplate) {
        try {
            const promptPath = path.resolve(process.cwd(), 'system_prompt.txt');
            systemPromptTemplate = await fs.readFile(promptPath, 'utf-8');
        } catch (error) {
            throw new Error(`无法加载 system_prompt.txt: ${error.message}`);
        }
    }
    return systemPromptTemplate;
}

/**
 * 加载编码规范（YAML）
 * @param {string} guidelinesFile - 规范文件路径（相对项目根目录）
 */
async function loadGuidelines(guidelinesFile = 'coding_guidelines.yaml') {
    try {
        const yaml = require('js-yaml');
        const guidelinesPath = path.resolve(process.cwd(), guidelinesFile);
        const content = await fs.readFile(guidelinesPath, 'utf-8');
        return yaml.load(content) || {};
    } catch (error) {
        console.warn(`未找到或无法解析规范文件 ${guidelinesFile}，将跳过规范检查。`);
        return {};
    }
}

/**
 * 构建 System Prompt
 * @param {Object} options
 * @param {Object} options.guidelines - 编码规范
 * @param {number} options.issueLimit - 问题数量限制
 * @param {boolean} options.enableAst - 是否启用 AST
 */
async function buildSystemPrompt({ guidelines, issueLimit, enableAst }) {
    const template = await loadSystemPromptTemplate();

    const guidelineIds = guidelines?.guidelines?.map(g => g.id).join(', ') || '';

    // 使用 JSON 格式化规范，减少提示词解析歧义
    const guidelinesText = guidelines && Object.keys(guidelines).length > 0
        ? JSON.stringify(guidelines, null, 2)
        : '未提供编码规范文件';

    let prompt = template
        .replace(/\{GUIDELINE_JSON_TEXT\}/g, guidelinesText)
        .replace(/\{GUIDELINE_IDS\}/g, guidelineIds)
        .replace(/\{ISSUE_LIMIT\}/g, String(issueLimit));

    // 未启用 AST 时移除 AST 说明段
    if (!enableAst) {
        prompt = prompt.replace(/<!-- AST_SECTION_START -->[\s\S]*?<!-- AST_SECTION_END -->\n?/g, '');
    }

    return prompt;
}

/**
 * 构建 User Content
 * @param {Object} options
 * @param {string} options.filePath - 文件路径
 * @param {string} options.extendedDiff - 带行号的 diff
 * @param {Object} options.astContext - AST 上下文（可选）
 */
function buildUserContent({ filePath, extendedDiff, astContext }) {
    const oldPath = filePath;
    const newPath = filePath;

    let content = `## new_path: ${newPath}\n## old_path: ${oldPath}\n${extendedDiff}`;

    // 只有在有 AST 命中代码段时才补充上下文
    if (astContext && astContext.impacted_sections && astContext.impacted_sections.length > 0) {
        content += '\n\n# AST 上下文（辅助信息）\n';
        content += '以下是包含变更行的完整函数/类代码，帮助理解修改上下文。\n';
        content += '**注意**：并非所有 Diff 都会有 AST 上下文，这是正常情况，请以 Diff 为主。\n\n';

        astContext.impacted_sections.forEach((section, index) => {
            content += `## 代码段 ${index + 1}: ${section.name}\n`;
            content += `- **类型**: ${section.type}\n`;
            content += `- **位置**: 第 ${section.start_line}-${section.end_line} 行\n`;
            content += `- **新增行号**: [${section.added_lines.join(', ')}]\n`;
            content += `- **完整代码**:\n\`\`\`\n${section.snippet}\n\`\`\`\n\n`;
        });

        if (astContext.errors && astContext.errors.length > 0) {
            content += `**注意**: AST 解析遇到以下问题: ${astContext.errors.join(', ')}\n`;
        }
    }

    return content;
}

module.exports = {
    loadGuidelines,
    buildSystemPrompt,
    buildUserContent,
};
