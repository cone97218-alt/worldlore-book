import { readFile, writeFile, deleteFile, listFiles } from '../core/workspace.js';
import {
    getRegexScripts,
    findRegexScript,
    applyRegexScript,
    deleteRegexScript,
    getRegexOverview,
    testRegexExecution,
    normalizeScope,
    scopeToString
} from '../st/regex-sync.js';

/**
 * Factory function producing the full set of regex tools:
 * CRUD (List, Get, Create, Patch, Delete, Import, Install) + Test
 * 
 * @param {object} helpers
 * @param {Function} helpers.addStagingEntry
 * @param {Function} helpers.addHistoryRecord
 * @returns {Array<object>}
 */
export function createRegexToolDefinitions({ addStagingEntry, addHistoryRecord }) {
    return [
        // =====================================================================
        // 1. READ: LIST REGEX SCRIPTS
        // =====================================================================
        {
            name: 'st_list_regex_scripts',
            displayName: '查看ST正则脚本列表(角色/全局/预设)',
            description: '查看SillyTavern中已安装的正则脚本列表。支持按作用域（角色专属 character / 全局 global / 提示词预设 preset / 全部 all）检索，返回每个脚本的名称、触发正则 findRegex、开关状态及生效位置。',
            parameters: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'string',
                        enum: ['character', 'global', 'preset', 'all'],
                        description: '检索作用域：character (角色专属，默认), global (全局生效), preset (生成预设绑定), all (全部汇总)'
                    }
                }
            },
            action: async (args) => {
                const scope = args.scope || 'character';
                if (scope === 'all') {
                    const overview = getRegexOverview();
                    return JSON.stringify({ success: true, scope: 'all', overview });
                }

                const scripts = getRegexScripts(scope);
                const summaries = scripts.map((s, idx) => ({
                    index: idx,
                    id: s.id,
                    scriptName: s.scriptName,
                    findRegex: s.findRegex,
                    disabled: !!s.disabled,
                    placement: s.placement,
                    replaceStringLength: (s.replaceString || '').length
                }));

                return JSON.stringify({
                    success: true,
                    scope,
                    count: summaries.length,
                    scripts: summaries
                });
            }
        },

        // =====================================================================
        // 2. DELETE: DELETE REGEX SCRIPT FROM ST SAFELY (WITH FULL UNDO BACKUP)
        // =====================================================================
        {
            name: 'st_delete_regex_script',
            displayName: '删除ST正则脚本(自动备份快照支持一键撤回恢复)',
            description: '从 SillyTavern 中彻底删除指定的正则脚本。删除前会自动备份完整脚本快照至操作日志，支持在抽屉操作日志中一键撤回恢复。当用户要求“把正则xxx删掉”、“删除某某状态栏规则”时调用。',
            parameters: {
                type: 'object',
                properties: {
                    script_name: {
                        type: 'string',
                        description: '要删除的正则脚本名称（必填）'
                    },
                    scope: {
                        type: 'string',
                        enum: ['character', 'global', 'preset', 'all'],
                        description: '作用域：character (角色专属), global (全局), preset (生成预设), all (自动检索，默认)'
                    },
                    delete_workspace_drafts: {
                        type: 'boolean',
                        description: '可选。是否同步清理工作区中同名的正则草稿文件夹（如 "regex/<脚本名>"，默认 false 保留草稿）'
                    }
                },
                required: ['script_name']
            },
            action: async (args) => {
                const scope = args.scope || 'all';
                const found = findRegexScript(scope, args.script_name);
                if (!found) {
                    return JSON.stringify({
                        success: false,
                        error: `在 [${scope}] 范围内未找到名为 "${args.script_name}" 的正则脚本！`
                    });
                }

                const res = await deleteRegexScript(found.scope, found.script.scriptName);

                // Optional: cleanup workspace draft folder
                let draftNotice = '';
                if (args.delete_workspace_drafts === true) {
                    const safeName = found.script.scriptName.replace(/[/\\:*?"<>|]/g, '_').trim();
                    const draftFolder = `regex/${safeName}`;
                    deleteFile(`${draftFolder}/replace.html`);
                    deleteFile(`${draftFolder}/meta.json`);
                    draftNotice = `，并已同步清理工作区草稿 [${draftFolder}]`;
                }

                // Record history for Undo rollback
                if (typeof addHistoryRecord === 'function') {
                    addHistoryRecord({
                        type: 'regex',
                        action: 'delete_regex',
                        target: `${found.scope}:${res.scriptName}`,
                        summary: `删除正则脚本: [${found.scope}] 《${res.scriptName}》${draftNotice}`,
                        beforeState: {
                            scope: found.scope,
                            scriptName: res.scriptName,
                            script: res.beforeState,
                            existed: true
                        },
                        afterState: null,
                        canUndo: true,
                    });
                }

                return JSON.stringify({
                    success: true,
                    script_name: res.scriptName,
                    scope: found.scope,
                    message: `成功删除 [${found.scope}] 作用域下的正则脚本《${res.scriptName}》！已自动备份快照，可随时在抽屉操作日志中一键撤回恢复${draftNotice}。`
                });
            }
        },

        // =====================================================================
        // 6. IMPORT: IMPORT REGEX INTO WORKSPACE DRAFT FOLDER
        // =====================================================================
        {
            name: 'st_import_regex_to_workspace',
            displayName: '将ST正则导入为工作区草稿(分离HTML与元数据)',
            description: '将SillyTavern中现有的超长前端美化正则脚本导入到工作区文件夹中。自动拆分为两个独立文件：replace.html（纯前端HTML/CSS/JS代码，可直接用 workspace_read 查看或 workspace_patch 差量修改）与 meta.json（存放触发正则、作用域、生效位置等元数据）。',
            parameters: {
                type: 'object',
                properties: {
                    script_name: {
                        type: 'string',
                        description: '要导入的ST正则脚本名称（必填）'
                    },
                    scope: {
                        type: 'string',
                        enum: ['character', 'global', 'preset', 'all'],
                        description: '来源作用域：character (角色专属), global (全局), preset (生成预设), all (自动检索，默认)'
                    },
                    folder_path: {
                        type: 'string',
                        description: '可选。自定义工作区目标文件夹路径，默认自动保存至: regex/<脚本名称>'
                    }
                },
                required: ['script_name']
            },
            action: async (args) => {
                const reqScope = args.scope || 'all';
                const found = findRegexScript(reqScope, args.script_name);

                if (!found) {
                    return JSON.stringify({
                        success: false,
                        error: `在 [${reqScope}] 范围内未找到名为 "${args.script_name}" 的正则脚本！可通过 st_list_regex_scripts 查看已安装列表。`
                    });
                }

                const script = found.script;
                const safeName = String(script.scriptName || 'regex_script').replace(/[/\\:*?"<>|]/g, '_').trim();
                const folder = (args.folder_path ? String(args.folder_path).trim().replace(/^\/+|\/+$/g, '') : `regex/${safeName}`);

                const metaPath = `${folder}/meta.json`;
                const htmlPath = `${folder}/replace.html`;

                const meta = {
                    id: script.id,
                    scriptName: script.scriptName,
                    scope: found.scope,
                    findRegex: script.findRegex || '',
                    placement: Array.isArray(script.placement) ? script.placement : [1, 2],
                    disabled: !!script.disabled,
                    markdownOnly: !!script.markdownOnly,
                    promptOnly: !!script.promptOnly,
                    runOnEdit: !!script.runOnEdit,
                    substituteRegex: script.substituteRegex ?? 0,
                    minDepth: script.minDepth ?? null,
                    maxDepth: script.maxDepth ?? null,
                    trimStrings: script.trimStrings || []
                };

                const htmlContent = script.replaceString || '';

                // Write to workspace
                writeFile(metaPath, JSON.stringify(meta, null, 2), 'overwrite');
                writeFile(htmlPath, htmlContent, 'overwrite');

                // Record history for audit & rollback
                if (typeof addHistoryRecord === 'function') {
                    addHistoryRecord({
                        type: 'workspace',
                        action: 'import_regex',
                        target: folder,
                        summary: `导入ST正则至工作区: "${script.scriptName}" (${found.scope}) ➔ ${folder}/`,
                        beforeState: null,
                        afterState: { folder, metaPath, htmlPath },
                        canUndo: true,
                    });
                }

                return JSON.stringify({
                    success: true,
                    script_name: script.scriptName,
                    scope: found.scope,
                    folder_path: folder,
                    html_file: htmlPath,
                    meta_file: metaPath,
                    html_length: htmlContent.length,
                    message: `成功将正则《${script.scriptName}》（来源: ${found.scope}）导入为工作区草稿！\n` +
                             `- 样式/代码文件: ${htmlPath} (${htmlContent.length} 字符)\n` +
                             `- 规则元数据: ${metaPath}\n\n` +
                             `后续操作指南：\n` +
                             `1. 你可以使用 [workspace_read] 查看代码，或使用 [workspace_patch] 对 ${htmlPath} 进行局部的精准差量修改；\n` +
                             `2. 调整完成后，调用 [st_install_regex_from_file(folder_path="${folder}")] 即可打包推送到审核区并应用到SillyTavern中。`
                });
            }
        },

        // =====================================================================
        // 7. INSTALL: INSTALL REGEX FROM WORKSPACE FOLDER (PUSH TO STAGING)
        // =====================================================================
        {
            name: 'st_install_regex_from_file',
            displayName: '将工作区正则安装到ST(推入审核区)',
            description: '将工作区中已编辑好的正则草稿文件夹（包含 replace.html 和 meta.json）打包安装到 SillyTavern 中。会自动推送到【待确认审核区】，支持在抽屉中查看代码修改对比 (Diff)，点击确认后即时生效。',
            parameters: {
                type: 'object',
                properties: {
                    folder_path: {
                        type: 'string',
                        description: '工作区正则文件夹路径，如 "regex/赛博状态栏"（必填）'
                    },
                    scope_override: {
                        type: 'string',
                        enum: ['character', 'global', 'preset'],
                        description: '可选。覆盖 meta.json 中指定的作用域（例如将角色专属正则转为全局生效）'
                    },
                    replace_existing: {
                        type: 'boolean',
                        description: '若 ST 中已存在同名正则脚本是否覆盖，默认为 true'
                    }
                },
                required: ['folder_path']
            },
            action: async (args) => {
                const folder = String(args.folder_path).trim().replace(/^\/+|\/+$/g, '');
                const metaPath = `${folder}/meta.json`;
                const htmlPath = `${folder}/replace.html`;

                const metaText = readFile(metaPath);
                if (metaText === null) {
                    return JSON.stringify({
                        success: false,
                        error: `工作区元数据文件未找到: ${metaPath}。请检查路径，或确认该文件夹是否包含 meta.json。`
                    });
                }

                let meta = {};
                try {
                    meta = JSON.parse(metaText);
                } catch (e) {
                    return JSON.stringify({
                        success: false,
                        error: `元数据文件 ${metaPath} 解析失败 (非合法JSON): ${e.message}`
                    });
                }

                const htmlContent = readFile(htmlPath);
                if (htmlContent === null) {
                    return JSON.stringify({
                        success: false,
                        error: `前端替换代码文件未找到: ${htmlPath}。正则草稿文件夹必须包含 replace.html 文件。`
                    });
                }

                const scriptName = meta.scriptName || folder.split('/').pop() || '未命名正则';
                const targetScope = args.scope_override || meta.scope || 'character';

                const completeScript = {
                    id: meta.id,
                    scriptName,
                    findRegex: meta.findRegex || '',
                    replaceString: htmlContent,
                    trimStrings: Array.isArray(meta.trimStrings) ? meta.trimStrings : [],
                    placement: Array.isArray(meta.placement) && meta.placement.length > 0 ? meta.placement : [1, 2],
                    disabled: meta.disabled === true,
                    markdownOnly: meta.markdownOnly === true,
                    promptOnly: meta.promptOnly === true,
                    runOnEdit: meta.runOnEdit === true,
                    substituteRegex: Number(meta.substituteRegex ?? 0),
                    minDepth: meta.minDepth !== undefined && meta.minDepth !== null ? Number(meta.minDepth) : null,
                    maxDepth: meta.maxDepth !== undefined && meta.maxDepth !== null ? Number(meta.maxDepth) : null,
                };

                // Check existing script in ST to prepare diff summary
                const existing = findRegexScript(targetScope, scriptName);
                const isUpdate = !!existing;

                let staged = null;
                if (typeof addStagingEntry === 'function') {
                    staged = addStagingEntry({
                        type: 'regex',
                        action: isUpdate ? 'update' : 'add',
                        target: `${targetScope}:${scriptName}`,
                        data: {
                            scope: targetScope,
                            scriptName,
                            script: completeScript,
                            from_folder: folder,
                            replace_existing: args.replace_existing !== false,
                            beforeScript: existing ? existing.script : null
                        },
                        summary: `[正则脚本: ${targetScope}] ${isUpdate ? '更新' : '新增'} "${scriptName}" (源于: ${folder})`
                    });
                }

                return JSON.stringify({
                    success: true,
                    staged_id: staged ? staged.id : null,
                    script_name: scriptName,
                    scope: targetScope,
                    action: isUpdate ? 'update' : 'add',
                    folder_path: folder,
                    replace_length: htmlContent.length,
                    message: `正则脚本《${scriptName}》（目标作用域: ${targetScope}）已成功推送到【待确认审核区】！` +
                             `请在右侧抽屉暂存区查看 Diff 对比并点击应用，生效后可在聊天中实时渲染。`
                });
            }
        },

        // =====================================================================
        // 8. TEST: RUN REGEX DRY-RUN TEST ON INPUT TEXT
        // =====================================================================
        {
            name: 'st_test_regex_script',
            displayName: '测试正则表达式替换效果(Dry-Run)',
            description: '在一段样例输入文本上测试正则表达式的匹配与替换效果，验证其是否能按预期捕获并渲染。可测试酒馆中已有的正则脚本，也可传入临时的 find_regex 与 replace_string 进行沙盒自测。',
            parameters: {
                type: 'object',
                properties: {
                    test_text: {
                        type: 'string',
                        description: '用于测试的原始输入文本（必填，例如 "<status>HP:100/100, MP:50/50</status>"）'
                    },
                    script_name: {
                        type: 'string',
                        description: '可选。测试酒馆中现有的某个正则脚本名称'
                    },
                    scope: {
                        type: 'string',
                        enum: ['character', 'global', 'preset', 'all'],
                        description: '可选。测试现有脚本时的作用域（默认 all）'
                    },
                    find_regex: {
                        type: 'string',
                        description: '可选。自定义临时匹配正则（未指定 script_name 时使用）'
                    },
                    replace_string: {
                        type: 'string',
                        description: '可选。自定义临时替换文本/HTML内容（未指定 script_name 时使用）'
                    }
                },
                required: ['test_text']
            },
            action: async (args) => {
                let targetScript = null;

                if (args.script_name) {
                    const found = findRegexScript(args.scope || 'all', args.script_name);
                    if (!found) {
                        return JSON.stringify({
                            success: false,
                            error: `未找到名为 "${args.script_name}" 的正则脚本，无法进行测试！`
                        });
                    }
                    targetScript = found.script;
                }

                try {
                    const res = testRegexExecution({
                        script: targetScript,
                        findRegex: args.find_regex,
                        replaceString: args.replace_string,
                        testText: args.test_text
                    });

                    return JSON.stringify({
                        success: true,
                        matched: res.matched,
                        script_name: targetScript ? targetScript.scriptName : '(临时沙盒规则)',
                        find_regex: targetScript ? targetScript.findRegex : args.find_regex,
                        original_text: res.original,
                        result_text: res.result,
                        diff_length: res.diffLength,
                        message: res.matched
                            ? `正则匹配成功！输入已成功被替换（长度变化: ${res.diffLength >= 0 ? '+' : ''}${res.diffLength} 字符）。`
                            : '正则未匹配到输入文本（输出与输入完全相同，未发生替换）。请检查 findRegex 语法是否匹配输入文本中的标签或空白符。'
                    });
                } catch (e) {
                    return JSON.stringify({
                        success: false,
                        error: `正则测试执行报错: ${e.message}`
                    });
                }
            }
        }
    ];
}
