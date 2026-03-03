/**
 * 从 diff 中提取代码片段（修复版）
 * @returns {{code: string, actualRange: string}} - 返回代码和实际行号范围
 */
function extractDiffCode(extendedDiffInfo, type, startLine, endLine) {
    if (!extendedDiffInfo) return { code: '', actualRange: '' };
    
    const linesMap = type === 'new' ? extendedDiffInfo.newLinesMap : extendedDiffInfo.oldLinesMap;
    if (!linesMap || linesMap.size === 0) return { code: '', actualRange: '' };
    
    // 获取可用的行号范围
    const availableLines = Array.from(linesMap.keys());
    if (availableLines.length === 0) return { code: '', actualRange: '' };
    
    const minAvailableLine = Math.min(...availableLines);
    const maxAvailableLine = Math.max(...availableLines);
    
    // 验证行号范围是否有效
    if (startLine > maxAvailableLine || endLine < minAvailableLine) {
        console.warn(`⚠️ 请求的行号 ${startLine}-${endLine} (${type}) 超出可用范围 ${minAvailableLine}-${maxAvailableLine}`);
        return { code: '', actualRange: `超出范围（可用：${minAvailableLine}-${maxAvailableLine}）` };
    }
    
    // 调整行号到有效范围内
    const adjustedStartLine = Math.max(minAvailableLine, Math.min(startLine, maxAvailableLine));
    const adjustedEndLine = Math.max(minAvailableLine, Math.min(endLine, maxAvailableLine));
    
    // 扩展上下文：前后各3行
    const contextLines = 3;
    const extendedStartLine = Math.max(minAvailableLine, adjustedStartLine - contextLines);
    const extendedEndLine = Math.min(maxAvailableLine, adjustedEndLine + contextLines);
    
    const lines = [];
    let actualFirstLine = null;
    let actualLastLine = null;
    
    for (let lineNum = extendedStartLine; lineNum <= extendedEndLine; lineNum++) {
        const line = linesMap.get(lineNum);
        if (line) {
            lines.push(line);
            if (actualFirstLine === null) actualFirstLine = lineNum;
            actualLastLine = lineNum;
        }
    }

    const actualRange = actualFirstLine !== null 
        ? `${actualFirstLine}${actualFirstLine !== actualLastLine ? `-${actualLastLine}` : ''}`
        : '';
    
    return { 
        code: lines.join('\n'), 
        actualRange 
    };
}

/**
 * 生成审查报告
 */
function generateReviewReport(reviews) {
    let report = '## 🤖 AI 代码审查报告\n\n > 💬 有问题或改进建议，请联系 **Geek L1n**（@linmingshen）\n\n ---\n\n';
    let summary = '';
    let details = '';
    let fileCount = 0;
    let issueCount = 0;
    let highSeverityCount = 0;
    let errorCount = 0;
    
    const sortedFiles = Object.keys(reviews).sort();

    for (const filePath of sortedFiles) {
        const result = reviews[filePath];
        if (!result) continue;
        
        fileCount++;
        
        // 统计错误文件
        if (result.status === 'ERROR') {
            errorCount++;
        }
        
        const currentFileIssues = result.issues || [];
        issueCount += currentFileIssues.length;

        const statusEmoji = getStatusEmoji(result.status);
        const added = result.added_lines || 0;
        const deleted = result.deleted_lines || 0;
        
        // 对于ERROR状态的文件，显示错误信息
        const findingsText = result.status === 'ERROR' 
            ? `⚠️ 审查失败` 
            : `${currentFileIssues.length} 个发现`;
        
        summary += `| ${statusEmoji} | \`${filePath}\` | +${added} / -${deleted} | ${findingsText} |\n`;

        if (currentFileIssues.length > 0) {
            // 使用增强报告格式（HTML表格）
            details += generateEnhancedFileDetails(filePath, result);
            
            // 统计高严重性问题
            currentFileIssues.forEach(issue => {
                if (issue.severity === '高' || issue.severity === '严重') {
                    highSeverityCount++;
                }
            });
        }
    }

    report += `### 📝 总结\n\n`;
    const successCount = fileCount - errorCount;
    report += `本次审查共分析了 **${fileCount}** 个文件`;
    if (errorCount > 0) {
        report += ` (✅ 成功: ${successCount} | ❌ 失败: ${errorCount})`;
    }
    report += `，发现 **${issueCount}** 个潜在问题，其中 **${highSeverityCount}** 个为高严重性问题。\n\n`;
    
    if (errorCount > 0) {
        report += `> ⚠️ **注意**: 有 ${errorCount} 个文件审查失败，可能是 API 错误或网络问题。\n\n`;
    }
    
    report += '| 状态 | 文件路径 | 代码变更 | 发现 |\n';
    report += '|:---:|:---|:---|:---|\n';
    report += summary;
    report += '\n';

    if (details) {
        report += `### 💡 详细建议\n\n`;
        report += details;
    }

    report += '---\n';
    report += '##### _报告由 X-LAB AI Code Review Bot 生成_';

    return report;
}

/**
 * 生成单个问题行的HTML
 */
function generateIssueRow(issue, result, filePath) {
    const { type, startLine, endLine, issueHeader, issueContent, severity, guidelineId } = issue;
    const severityBadge = getSeverityBadge(severity || '中');
    const guidelineBadge = guidelineId ? ` <code>${escapeHtml(guidelineId)}</code>` : '';
    
    let row = '    <tr>\n';
    
    // 问题列
    row += `      <td>${severityBadge} ${escapeHtml(issueHeader || issue.issueType || '代码问题')}${guidelineBadge}</td>\n`;
    
    // 代码位置列
    row += '      <td>';
    row += generateLocationCell(issue, result, filePath);
    row += '</td>\n';
    
    // 描述列
    row += `      <td>${escapeHtml(issueContent || issue.description || '')}</td>\n`;
    row += '    </tr>\n';
    
    return row;
}

/**
 * 生成位置单元格内容
 */
function generateLocationCell(issue, result, filePath) {
    const { type, startLine, endLine } = issue;
    const lineStart = startLine || issue.line || 1;
    const lineEnd = endLine || issue.line || 1;
    
    let content = lineStart === lineEnd 
        ? `第 ${lineStart} 行` 
        : `第 ${lineStart}-${lineEnd} 行`;
    
    // 添加可折叠的代码块
    if (result.extendedDiffInfo && startLine && endLine) {
        const extractResult = extractDiffCode(result.extendedDiffInfo, type || 'new', startLine, endLine);
        
        if (extractResult.code && extractResult.code.trim()) {
            // 检查行号是否匹配
            const isRangeMismatch = extractResult.actualRange && 
                extractResult.actualRange !== `${startLine}` && 
                extractResult.actualRange !== `${startLine}-${endLine}`;
                
            if (isRangeMismatch) {
                content += ` <small style="color:orange;">(实际diff行: ${extractResult.actualRange})</small>`;
            }
            
            content += '\n<details><summary>📝 查看代码</summary>\n\n';
            content += '```diff\n';
            content += extractResult.code;
            content += '\n```\n';
            content += '</details>';
        }
    }
    
    return content;
}

/**
 * 生成增强版文件详情（HTML表格）
 */
function generateEnhancedFileDetails(filePath, result) {
    const issues = result.issues || [];
    let details = `### 📄 \`${escapeHtml(filePath)}\`\n\n`;
    
    details += '<table>\n';
    details += '  <thead>\n';
    details += '    <tr>\n';
    details += '      <th><strong>问题</strong></th>\n';
    details += '      <th><strong>代码位置</strong></th>\n';
    details += '      <th><strong>描述</strong></th>\n';
    details += '    </tr>\n';
    details += '  </thead>\n';
    details += '  <tbody>\n';

    for (const issue of issues) {
        details += generateIssueRow(issue, result, filePath);
    }

    details += '  </tbody>\n';
    details += '</table>\n\n';

    return details;
}

/**
 * 获取严重性图标和文字
 */
function getSeverityBadge(severity) {
    switch (severity) {
        case '高':
            return '🔴 高';
        case '严重':
            return '🔴 严重';
        case '中':
            return '🟡 中';
        case '低':
            return '🟢 低';
        default:
            return 'ℹ️ 信息';
    }
}

/**
 * 获取状态图标
 */
function getStatusEmoji(status) {
    switch (status) {
        case 'PASS': return '✅';
        case 'WARNING': return '⚠️';
        case 'ERROR': return '❌';
        default: return 'ℹ️';
    }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


module.exports = {
    generateReviewReport,
};
