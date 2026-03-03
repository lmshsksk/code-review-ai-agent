const pLimit = require('p-limit');
const { loadRuntimeConfig } = require('./config');
const { getGitDiffs, postComment, deletePastComments, postLineComment, deletePastLineComments } = require('./gitlab_api');
const { reviewFiles } = require('./review_engine');
const { loadGuidelines } = require('./prompt_builder');
const { generateReviewReport } = require('./report');

/**
 * 准备待审查的文件列表
 * @param {Array} diffs - GitLab 返回的 diff 数组
 * @param {Object} config - 运行时配置
 * @returns {{filesToReview: Array, skippedFiles: Array}}
 */
function prepareFilesForReview(diffs, config) {
    const filesToReview = [];
    const skippedFiles = [];

    diffs.forEach(d => {
        // 跳过二进制文件
        if (!d.diff || d.diff.startsWith('Binary files')) {
            return;
        }

        const header = `diff --git a/${d.old_path} b/${d.new_path}\n--- a/${d.old_path}\n+++ b/${d.new_path}\n`;
        const fullDiff = header + d.diff;

        // 检查 diff 大小
        const diffLines = fullDiff.split('\n').length;
        const diffChars = fullDiff.length;

        // 超过限制则跳过
        if (diffLines > config.maxDiffLines || diffChars > config.maxDiffChars) {
            skippedFiles.push({
                path: d.new_path,
                reason: 'diff_too_large',
                lines: diffLines,
                chars: diffChars,
                maxLines: config.maxDiffLines,
                maxChars: config.maxDiffChars,
            });
            console.warn(
                `跳过文件 ${d.new_path}: diff 过大 (${diffLines}行/${diffChars}字符, ` +
                `限制: ${config.maxDiffLines}行/${config.maxDiffChars}字符)`
            );
            return;
        }

        filesToReview.push({
            path: d.new_path,
            diff: fullDiff,
            old_path: d.old_path,
        });
    });

    return { filesToReview, skippedFiles };
}

/**
 * 发布报告模式
 */
async function publishReport(reviews, config) {
    // 仅使用核心标题关键词，兼容历史版本（含 emoji 标题）评论清理
    const identifier = 'AI 代码审查报告';
    await deletePastComments(identifier, config);

    // 生成汇总报告并发布
    const report = generateReviewReport(reviews);
    await postComment(report, config);
}

/**
 * 发布行级评论模式
 */
async function publishInlineComments(reviews, diffs, diffRefs, config) {
    const identifier = '<!-- AI_CODE_REVIEW_LINE_COMMENT -->';
    await deletePastLineComments(identifier, config);

    const limit = pLimit(config.maxParallel);
    const commentPromises = [];
    let totalComments = 0;

    for (const filePath in reviews) {
        const review = reviews[filePath];
        if (!review?.issues || review.issues.length === 0) continue;

        const diffInfo = diffs.find(d => d.new_path === filePath);
        if (!diffInfo) {
            console.warn(`未找到 ${filePath} 的 diff 信息，跳过行级评论`);
            continue;
        }

        for (const issue of review.issues) {
            // 确定行号
            const issueLine = issue.startLine || issue.line;
            if (!issueLine || issueLine < 1) {
                console.warn(`跳过无效行号的问题: ${filePath} (行号: ${issueLine})`);
                continue;
            }

            // 构建 GitLab 行级评论位置参数
            const position = {
                ...diffRefs,
                position_type: 'text',
                old_path: issue.type === 'old' ? (issue.oldPath || diffInfo.old_path) : diffInfo.old_path,
                new_path: issue.type === 'new' ? (issue.newPath || diffInfo.new_path) : diffInfo.new_path,
            };

            if (issue.type === 'old') {
                position.old_line = issueLine;
            } else {
                position.new_line = issueLine;
            }

            // 构建评论内容
            const severityBadge = issue.severity === '高' ? '[高]' : issue.severity === '中' ? '[中]' : '[低]';
            const guidelineBadge = issue.guidelineId || issue.guideline_id
                ? ` [${issue.guidelineId || issue.guideline_id}]`
                : '';
            const commentBody = `${identifier}\n**[AI 建议]** ${severityBadge}${guidelineBadge}\n\n` +
                `**${issue.issueHeader || issue.issueType || '代码问题'}**\n\n` +
                `${issue.issueContent || issue.description}`;

            commentPromises.push(limit(() => postLineComment(commentBody, position, config)));
            totalComments++;
        }
    }

    if (totalComments === 0) {
        console.log('没有需要发布的行级评论');
        return;
    }

    await Promise.all(commentPromises);
    console.log(`所有行级评论发布完成 (共 ${totalComments} 条)`);
}

/**
 * 主审查流程
 * @param {Object} options
 * @param {Object} options.configOverrides - 运行时覆盖配置（用于 webhook）
 */
async function runReview(options = {}) {
    const { configOverrides = {} } = options;
    const config = loadRuntimeConfig(configOverrides);

    console.log(`开始审查 (模式=${config.reviewMode}, 模型=${config.aiModel}, 并发=${config.maxParallel})`);

    // 加载规则和 diff 数据
    const [guidelines, { diffs, diffRefs }] = await Promise.all([
        loadGuidelines(config.guidelinesFile),
        getGitDiffs(config),
    ]);

    // 预处理文件列表
    const { filesToReview, skippedFiles } = prepareFilesForReview(diffs, config);

    console.log(`文件统计: 总计 ${diffs.length} 个变更文件`);
    console.log(`  待审查: ${filesToReview.length}`);
    if (skippedFiles.length > 0) {
        console.log(`  已跳过: ${skippedFiles.length} (diff 过大)`);
        skippedFiles.forEach(sf => {
            console.log(`    - ${sf.path} (${sf.lines}行/${sf.chars}字符)`);
        });
    }

    if (filesToReview.length === 0) {
        console.log('没有可审查的文件');
        return {
            reviews: {},
            stats: {
                totalFiles: diffs.length,
                reviewedFiles: 0,
                skippedFiles,
                successCount: 0,
                errorCount: 0,
            },
        };
    }

    // 执行审查
    const reviews = await reviewFiles(filesToReview, config, guidelines);

    const successCount = Object.values(reviews).filter(r => r.status !== 'ERROR').length;
    const errorCount = Object.values(reviews).filter(r => r.status === 'ERROR').length;

    // 全部失败时抛错，交由调用方决定如何处理
    if (successCount === 0 && errorCount > 0) {
        throw new Error(`所有文件审查失败 (${errorCount}/${filesToReview.length})，请检查 API 配置和网络连接`);
    }

    console.log('生成并发布审查结果...');

    if (config.reviewMode === 'inline') {
        await publishInlineComments(reviews, diffs, diffRefs, config);
    } else {
        await publishReport(reviews, config);
    }

    if (errorCount > 0) {
        console.log(`审查完成，但有 ${errorCount} 个文件审查失败`);
    } else {
        console.log('审查完成');
    }

    return {
        reviews,
        stats: {
            totalFiles: diffs.length,
            reviewedFiles: filesToReview.length,
            skippedFiles,
            successCount,
            errorCount,
        },
    };
}

/**
 * CLI 入口函数
 */
async function main() {
    try {
        await runReview();
    } catch (error) {
        console.error('执行失败:', error.message || error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    runReview,
    prepareFilesForReview,
};
