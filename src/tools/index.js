import { getContext } from '/scripts/extensions.js';
import { ToolManager } from '/scripts/tool-calling.js';
import { getSettings, saveWorkspace, writeFile, readFile, readFileSlice, deleteFile, renameFile, listFiles, searchFiles, renameProject, getActiveProjectName } from '../core/workspace.js';
import { applyRegexScript, deleteRegexScript } from '../st/regex-sync.js';
import { createRegexToolDefinitions } from './regex-tools.js';
import { applyWorldInfoEntry, applyCharacterFieldUpdate, applyPersonaFieldUpdate, getAvailableWorldInfos, getCharacterBoundLorebooks, getCurrentCharacter, getCurrentPersona, getLorebooksOverview, readLorebookEntriesScoped, createAndBindWorldInfo, restoreCharacterLorebookBinding, deleteWorldInfoSafely, restoreDeletedWorldInfo } from '../st/st-sync.js';
import { importLorebookToWorkspace, importCharacterToWorkspace, importPersonaToWorkspace, parseFrontmatter } from '../st/import-sync.js';
import { storeDiff } from '../utils/diff.js';

export function getStagingEntries() {
    const settings = getSettings();
    return settings.staging?.entries || [];
}

export function getHistoryEntries() {
    const settings = getSettings();
    return settings.history || [];
}

export function addStagingEntry(entry) {
    const settings = getSettings();
    if (!settings.staging) settings.staging = { entries: [] };
    const id = 'stage_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const stagedItem = {
        id,
        type: entry.type,
        action: entry.action || 'update',
        target: entry.target || '',
        data: entry.data || {},
        summary: entry.summary || '',
        timestamp: Date.now(),
        status: 'pending',
    };
    settings.staging.entries.unshift(stagedItem);
    saveWorkspace();
    emitStagingUpdated();
    return stagedItem;
}

export function removeStagingEntry(id) {
    const settings = getSettings();
    if (settings.staging?.entries) {
        settings.staging.entries = settings.staging.entries.filter(e => e.id !== id);
        saveWorkspace();
        emitStagingUpdated();
        return true;
    }
    return false;
}

export function clearStaging() {
    const settings = getSettings();
    if (settings.staging) {
        settings.staging.entries = [];
        saveWorkspace();
        emitStagingUpdated();
    }
}

export function addHistoryRecord(record) {
    const settings = getSettings();
    if (!settings.history) settings.history = [];
    const historyItem = {
        id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        timestamp: Date.now(),
        type: record.type,
        action: record.action || 'apply',
        target: record.target || '',
        summary: record.summary || '',
        beforeState: record.beforeState || null,
        afterState: record.afterState || null,
        canUndo: record.canUndo !== false,
        undone: false,
    };
    settings.history.unshift(historyItem);
    if (settings.history.length > 200) {
        settings.history = settings.history.slice(0, 200);
    }
    saveWorkspace();
    emitHistoryUpdated();
    return historyItem;
}

export function clearHistory() {
    const settings = getSettings();
    settings.history = [];
    saveWorkspace();
    emitHistoryUpdated();
}

export function emitStagingUpdated() {
    window.dispatchEvent(new CustomEvent('worldlore_staging_updated', { detail: { entries: getStagingEntries() } }));
}

export function emitHistoryUpdated() {
    window.dispatchEvent(new CustomEvent('worldlore_history_updated', { detail: { entries: getHistoryEntries() } }));
}

export async function applyStagingEntry(id) {
    const settings = getSettings();
    const item = settings.staging?.entries?.find(e => e.id === id);
    if (!item) throw new Error(`Staged item ${id} not found`);

    let result = null;
    let beforeState = null;
    let afterState = null;

    if (item.type === 'lorebook') {
        result = await applyWorldInfoEntry(item.target, item.data);
        beforeState = result.beforeState;
        afterState = result.afterState;
    } else if (item.type === 'character') {
        result = await applyCharacterFieldUpdate(item.data);
        beforeState = result.beforeState;
        afterState = result.afterState;
    } else if (item.type === 'persona') {
        result = await applyPersonaFieldUpdate(item.data);
        beforeState = result.beforeState;
        afterState = result.afterState;
    } else if (item.type === 'workspace') {
        beforeState = { content: readFile(item.target) };
        result = writeFile(item.target, item.data.content, item.data.mode);
        afterState = { content: item.data.content };
    } else if (item.type === 'regex') {
        if (item.action === 'delete') {
            const res = await deleteRegexScript(item.data.scope, item.data.scriptName);
            beforeState = { scope: item.data.scope, script: res.beforeState, existed: true };
            afterState = null;
            result = res;
        } else {
            const res = await applyRegexScript(item.data.scope, item.data.script, item.data.replace_existing !== false);
            beforeState = res.beforeState
                ? { scope: item.data.scope, script: res.beforeState, existed: true }
                : { scope: item.data.scope, scriptName: item.data.scriptName, existed: false };
            afterState = { scope: item.data.scope, script: res.script };
            result = res;
        }
    }

    addHistoryRecord({
        type: item.type,
        action: item.action,
        target: item.target,
        summary: `已应用: ${item.summary || item.target}`,
        beforeState,
        afterState,
        canUndo: true,
    });

    item.status = 'applied';
    removeStagingEntry(id);
    return result;
}

export async function applyAllStaging() {
    const entries = [...getStagingEntries()];
    const results = [];
    for (const item of entries) {
        try {
            const res = await applyStagingEntry(item.id);
            results.push({ id: item.id, success: true, result: res });
        } catch (e) {
            console.error(`[Worldlore Agent] Failed to apply staging entry ${item.id}:`, e);
            results.push({ id: item.id, success: false, error: e.message });
        }
    }
    return results;
}

/**
 * Executes a full Rollback / Undo for a history entry
 */
export async function undoHistoryRecord(historyId) {
    const settings = getSettings();
    const item = settings.history?.find(h => h.id === historyId);
    if (!item) throw new Error('未找到该条历史日志');
    if (item.undone) throw new Error('该操作此前已被撤回');
    if (!item.canUndo) throw new Error('该操作不支持撤回');

    if (item.type === 'lorebook') {
        if (item.action === 'add') {
            const uid = item.afterState?.uid;
            const comment = item.afterState?.comment;
            await applyWorldInfoEntry(item.target, { action: 'delete', uid, comment });
        } else if (item.action === 'update') {
            if (!item.beforeState) throw new Error('无修改前快照数据');
            await applyWorldInfoEntry(item.target, { action: 'update', uid: item.beforeState.uid, ...item.beforeState });
        } else if (item.action === 'delete') {
            if (!item.beforeState) throw new Error('无删除前快照数据');
            await applyWorldInfoEntry(item.target, { action: 'add', ...item.beforeState });
        } else if (item.action === 'create_and_bind') {
            await restoreCharacterLorebookBinding({
                previousPrimary: item.beforeState?.previousPrimary,
                addedAuxBook: item.beforeState?.bindType === 'additional' ? item.target : null
            });
        } else if (item.action === 'delete_lorebook') {
            if (!item.beforeState) throw new Error('无世界书删除前备份快照');
            await restoreDeletedWorldInfo(item.beforeState);
        }
    } else if (item.type === 'character') {
        if (!item.beforeState) throw new Error('无角色修改前快照');
        const updates = { mode: 'replace' };
        for (const [f, val] of Object.entries(item.beforeState)) {
            updates[f] = val;
        }
        await applyCharacterFieldUpdate(updates);
    } else if (item.type === 'persona') {
        if (!item.beforeState) throw new Error('无人设修改前快照');
        await applyPersonaFieldUpdate({
            description: item.beforeState.description,
            depth: item.beforeState.depth,
            position: item.beforeState.position,
            lorebook: item.beforeState.lorebook,
            mode: 'replace'
        });
    } else if (item.type === 'workspace') {
        if (item.action === 'delete') {
            if (item.beforeState?.content !== undefined && item.beforeState?.content !== null) {
                writeFile(item.target, item.beforeState.content, 'overwrite');
            }
        } else if (item.action === 'rename') {
            renameFile(item.afterState.path, item.beforeState.path);
        } else if (item.action === 'rename_project') {
            renameProject(item.afterState.name, item.beforeState.name);
        } else if (item.beforeState?.content === null || item.beforeState?.content === undefined) {
            deleteFile(item.target);
        } else {
            writeFile(item.target, item.beforeState.content, 'overwrite');
        }
    } else if (item.type === 'regex') {
        if (!item.beforeState) throw new Error('无正则修改前快照');
        if (item.beforeState.existed && item.beforeState.script) {
            await applyRegexScript(item.beforeState.scope, item.beforeState.script, true);
        } else {
            const targetScope = item.beforeState.scope || item.afterState?.scope || 'character';
            const targetName = item.beforeState.scriptName || item.afterState?.script?.scriptName;
            if (targetName) {
                await deleteRegexScript(targetScope, targetName);
            }
        }
    }

    item.undone = true;
    saveWorkspace();
    emitHistoryUpdated();
    return { success: true, message: `已成功撤回: ${item.summary}` };
}

/**
 * Redo an undone history entry directly
 */
export async function redoHistoryRecord(historyId) {
    const settings = getSettings();
    const item = settings.history?.find(h => h.id === historyId);
    if (!item) throw new Error('未找到该条历史日志');
    if (!item.undone) throw new Error('该操作处于激活状态，无需重做');

    if (item.type === 'lorebook') {
        if (item.action === 'add' || item.action === 'update') {
            if (!item.afterState) throw new Error('无新状态快照');
            await applyWorldInfoEntry(item.target, { action: 'update', ...item.afterState });
        } else if (item.action === 'delete') {
            await applyWorldInfoEntry(item.target, { action: 'delete', uid: item.afterState?.uid, comment: item.afterState?.comment });
        } else if (item.action === 'create_and_bind') {
            await createAndBindWorldInfo({
                bookName: item.target,
                bind: true,
                bindType: item.afterState?.bindType || 'primary'
            });
        } else if (item.action === 'delete_lorebook') {
            await deleteWorldInfoSafely(item.target);
        }
    } else if (item.type === 'character') {
        if (!item.afterState) throw new Error('无角色快照');
        const updates = { mode: 'replace' };
        for (const [f, val] of Object.entries(item.afterState)) {
            updates[f] = val;
        }
        await applyCharacterFieldUpdate(updates);
    } else if (item.type === 'persona') {
        if (!item.afterState) throw new Error('无人设快照');
        await applyPersonaFieldUpdate({
            description: item.afterState.description,
            depth: item.afterState.depth,
            position: item.afterState.position,
            lorebook: item.afterState.lorebook,
            mode: 'replace'
        });
    } else if (item.type === 'workspace') {
        if (item.action === 'delete') {
            deleteFile(item.target);
        } else if (item.action === 'rename') {
            renameFile(item.beforeState.path, item.afterState.path);
        } else if (item.action === 'rename_project') {
            renameProject(item.beforeState.name, item.afterState.name);
        } else if (item.afterState?.content !== undefined) {
            writeFile(item.target, item.afterState.content, 'overwrite');
        }
    } else if (item.type === 'regex') {
        if (item.action === 'delete_regex' || item.action === 'delete') {
            const targetScope = item.beforeState?.scope || 'character';
            const targetName = item.beforeState?.scriptName || item.beforeState?.script?.scriptName;
            if (targetName) await deleteRegexScript(targetScope, targetName);
        } else {
            if (!item.afterState?.script) throw new Error('无新正则快照');
            await applyRegexScript(item.afterState.scope || 'character', item.afterState.script, true);
        }
    }

    item.undone = false;
    saveWorkspace();
    emitHistoryUpdated();
    return { success: true, message: `已成功重做: ${item.summary}` };
}

/**
 * Re-Stage an undone history entry back to the Staging area
 */
export function restageHistoryRecord(historyId) {
    const settings = getSettings();
    const item = settings.history?.find(h => h.id === historyId);
    if (!item) throw new Error('未找到该条历史日志');

    let stagedData = {};
    if (item.type === 'lorebook') {
        stagedData = item.afterState || item.data || {};
    } else if (item.type === 'character' || item.type === 'persona') {
        stagedData = item.afterState || item.data || {};
    } else if (item.type === 'workspace') {
        stagedData = { content: item.afterState?.content || '', mode: 'overwrite' };
    } else if (item.type === 'regex') {
        stagedData = item.afterState ? {
            scope: item.afterState.scope,
            scriptName: item.afterState.script?.scriptName,
            script: item.afterState.script,
            replace_existing: true
        } : (item.data || {});
    }

    const cleanSummary = String(item.summary).replace(/^已应用:\s*/, '').replace(/^已撤回:\s*/, '');
    const staged = addStagingEntry({
        type: item.type,
        action: item.action || 'update',
        target: item.target,
        data: stagedData,
        summary: `[重新暂存] ${cleanSummary}`
    });

    return staged;
}

export const TOOL_DEFINITIONS = [
    // --- WORKSPACE DRAFT TOOLS ---
    {
        name: 'workspace_write',
        displayName: '工作区写入文件',
        description: '在草稿工作区中创建、覆盖或追加写入文件/设定草稿。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件相对路径，如 world/magic_system.md 或 characters/alice.md' },
                content: { type: 'string', description: '要写入的完整文本内容或追加内容' },
                mode: { type: 'string', enum: ['overwrite', 'append', 'create'], description: '写入模式，默认为 overwrite' }
            },
            required: ['path', 'content']
        },
        action: async (args) => {
            const prevContent = readFile(args.path);
            const res = writeFile(args.path, args.content, args.mode || 'overwrite');
            addHistoryRecord({
                type: 'workspace',
                action: 'write',
                target: args.path,
                summary: `工作区草稿写入: ${args.path} (${args.mode || 'overwrite'})`,
                beforeState: { content: prevContent },
                afterState: { content: readFile(args.path) },
                canUndo: true,
            });
            const newContent = readFile(args.path);
            const diffId = prevContent !== null ? storeDiff(prevContent, newContent, `写入修改: ${res.path}`) : undefined;
            return JSON.stringify({
                success: true,
                message: `成功写入草稿 ${res.path} (${res.length} 字符)`,
                path: res.path,
                diff_id: diffId
            });
        }
    },
    {
        name: 'workspace_read',
        displayName: '工作区读取文件（支持按行切片）',
        description: '读取工作区中指定草稿文件的内容。支持传入 start_line 与 end_line（1-based 起始行号）进行局部切片读取，极大降低 Token 消耗并加速响应；针对超长代码/正则文件推荐先用 workspace_search 定位行号再切片读取。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件相对路径，如 "regex/状态栏/replace.html"' },
                start_line: { type: 'integer', description: '可选。起始行号（从 1 开始）。若指定，仅读取指定行号区间的切片' },
                end_line: { type: 'integer', description: '可选。结束行号（从 1 开始，包含该行）。若指定，仅读取至该行' },
                with_line_numbers: { type: 'boolean', description: '可选。切片时是否在每行前缀带上行号（如 "  42: <div>"），默认 true' }
            },
            required: ['path']
        },
        action: async (args) => {
            const path = args.path;
            const sliceRes = readFileSlice(
                path,
                args.start_line !== undefined ? args.start_line : null,
                args.end_line !== undefined ? args.end_line : null,
                args.with_line_numbers !== false
            );
            if (sliceRes === null) {
                return JSON.stringify({ success: false, error: `File not found: ${path}` });
            }

            let advice = '';
            if (!sliceRes.isSliced && (sliceRes.totalLines > 150 || sliceRes.chars > 6000)) {
                advice = `【性能提示】该文件较大（共 ${sliceRes.totalLines} 行，${sliceRes.chars} 字符）。建议后续通过 workspace_search 定位关键词行号，或使用 workspace_read(start_line, end_line) 进行局部视窗切片，以降低 Token 消耗并提高精确度。`;
            }

            return JSON.stringify({
                success: true,
                path,
                total_lines: sliceRes.totalLines,
                is_sliced: sliceRes.isSliced,
                start_line: sliceRes.startLine,
                end_line: sliceRes.endLine,
                content: sliceRes.content,
                advice: advice || undefined
            });
        }
    },
    {
        name: 'workspace_search',
        displayName: '工作区搜索设定(支持行号定位)',
        description: '在工作区草稿中全文搜索关键词，返回匹配的文件路径、总行数及每个匹配项的精确行号 (line) 与行文本。支持通过 path 限制在单个大文件（如 replace.html）内搜索，快速获取修改目标附近的行号。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                path: { type: 'string', description: '可选。限制只在指定的草稿文件内搜索（如 "regex/状态栏/replace.html"）' }
            },
            required: ['query']
        },
        action: async (args) => {
            const results = searchFiles(args.query, { path: args.path });
            return JSON.stringify({
                success: true,
                query: args.query,
                target_path: args.path || 'all',
                matchesCount: results.length,
                results
            });
        }
    },
    {
        name: 'workspace_list',
        displayName: '工作区列出文件',
        description: '列出工作区中所有的草稿文件列表。',
        parameters: {
            type: 'object',
            properties: {
                prefix: { type: 'string', description: '可选的前缀目录过滤，如 world/' }
            }
        },
        action: async (args) => {
            const files = listFiles(args.prefix || '');
            return JSON.stringify({ success: true, count: files.length, files });
        }
    },
    {
        name: 'workspace_delete',
        displayName: '工作区删除草稿(支持操作日志一键撤回)',
        description: '删除工作区中指定的草稿文件。删除前会自动备份文件正文快照，支持在操作日志中一键撤回恢复。当用户要求“把工作区里的xxx草稿删掉”、“删除某某草稿文件”时调用。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要删除的文件相对路径，如 "world/timeline.md"' }
            },
            required: ['path']
        },
        action: async (args) => {
            const existing = readFile(args.path);
            if (existing === null) {
                return JSON.stringify({ success: false, error: `草稿文件不存在: ${args.path}` });
            }
            const deleted = deleteFile(args.path);
            if (!deleted) {
                return JSON.stringify({ success: false, error: `删除文件失败: ${args.path}` });
            }

            addHistoryRecord({
                type: 'workspace',
                action: 'delete',
                target: args.path,
                summary: `删除工作区草稿: ${args.path} (${existing.length} 字符)`,
                beforeState: { path: args.path, content: existing },
                afterState: { path: args.path },
                canUndo: true,
            });

            return JSON.stringify({
                success: true,
                path: args.path,
                message: `成功删除工作区草稿 "${args.path}"（已自动备份快照，可在操作日志中一键撤回恢复）。`
            });
        }
    },
    {
        name: 'workspace_rename',
        displayName: '工作区重命名草稿',
        description: '重命名工作区中的草稿文件或移动文件路径。支持操作日志一键撤回。当用户要求“把草稿重命名为xxx”、“把xxx文件改名为yyy”时调用。',
        parameters: {
            type: 'object',
            properties: {
                old_path: { type: 'string', description: '原草稿文件相对路径，如 "world/magic.md"' },
                new_path: { type: 'string', description: '新草稿文件相对路径，如 "world/magic_system.md"' }
            },
            required: ['old_path', 'new_path']
        },
        action: async (args) => {
            const oldPath = args.old_path || args.from_path || args.path;
            const newPath = args.new_path || args.to_path;
            if (!oldPath || !newPath) {
                return JSON.stringify({ success: false, error: '缺少 old_path 或 new_path 参数' });
            }
            try {
                renameFile(oldPath, newPath);
                addHistoryRecord({
                    type: 'workspace',
                    action: 'rename',
                    target: newPath,
                    summary: `重命名草稿: ${oldPath} ➔ ${newPath}`,
                    beforeState: { path: oldPath },
                    afterState: { path: newPath },
                    canUndo: true,
                });
                return JSON.stringify({
                    success: true,
                    old_path: oldPath,
                    new_path: newPath,
                    message: `成功将草稿 "${oldPath}" 重命名为 "${newPath}"（已记录操作日志，支持撤回）。`
                });
            } catch (e) {
                return JSON.stringify({ success: false, error: e.message });
            }
        }
    },
    {
        name: 'workspace_rename_project',
        displayName: '工作区重命名项目',
        description: '重命名当前或指定的工作区写卡项目名称。支持操作日志一键撤回。当用户要求“把当前工作区改名为xxx”、“重命名工作区/项目”时调用。',
        parameters: {
            type: 'object',
            properties: {
                new_name: { type: 'string', description: '新工作区项目名称' },
                old_name: { type: 'string', description: '可选。原工作区项目名称（留空则默认当前激活的工作区）' }
            },
            required: ['new_name']
        },
        action: async (args) => {
            const oldName = args.old_name || getActiveProjectName();
            const newName = args.new_name;
            if (!newName) {
                return JSON.stringify({ success: false, error: '缺少 new_name 参数' });
            }
            try {
                renameProject(oldName, newName);
                addHistoryRecord({
                    type: 'workspace',
                    action: 'rename_project',
                    target: newName,
                    summary: `重命名工作区: ${oldName} ➔ ${newName}`,
                    beforeState: { name: oldName },
                    afterState: { name: newName },
                    canUndo: true,
                });
                return JSON.stringify({
                    success: true,
                    old_name: oldName,
                    new_name: newName,
                    message: `成功将工作区 "${oldName}" 重命名为 "${newName}"（已记录操作日志，支持撤回）。`
                });
            } catch (e) {
                return JSON.stringify({ success: false, error: e.message });
            }
        }
    },

    // --- MULTI-SCOPE LOREBOOK READ & OVERVIEW TOOLS ---
    {
        name: 'st_read_lorebook',
        displayName: '读取ST世界书条目(支持角色/聊天/全局/指定书名)',
        description: '读取SillyTavern世界书已有条目。支持按范围（角色专属/当前聊天/全局常驻/所有激活/全库）读取，或直接传入具体 book_name 精准读取任意世界书。返回结果包含蓝灯(constant)、开启/关闭(enabled)、顺序(order)、位置(position)、深度(depth)等全属性。',
        parameters: {
            type: 'object',
            properties: {
                scope: {
                    type: 'string',
                    enum: ['character', 'chat', 'global', 'active', 'all'],
                    description: '读取范围：character (角色绑定世界书，默认), chat (当前聊天绑定世界书), global (全局世界书), active (所有激活世界书), all (全部可用世界书)'
                },
                book_name: {
                    type: 'string',
                    description: '可选。若指定具体的世界书名称（如"赛博设定集"），则优先直接读取该书，无视 scope。'
                },
                query: {
                    type: 'string',
                    description: '可选的关键词/标题过滤条件'
                },
                max_entries: {
                    type: 'number',
                    description: '最多返回条目数量（默认40）'
                }
            }
        },
        action: async (args) => {
            const res = await readLorebookEntriesScoped({
                scope: args.scope || 'character',
                book_name: args.book_name,
                query: args.query,
                max_entries: args.max_entries || 40
            });
            return JSON.stringify(res);
        }
    },
    {
        name: 'st_get_lorebooks_overview',
        displayName: '查看世界书全景总览',
        description: '查看当前酒馆中所有世界书的分布与激活状态（包含角色绑定、当前聊天绑定、全局常驻、全部已安装列表）。',
        parameters: { type: 'object', properties: {} },
        action: async () => {
            const overview = getLorebooksOverview();
            return JSON.stringify(overview);
        }
    },
    {
        name: 'st_get_character',
        displayName: '读取当前角色卡设定',
        description: '读取当前酒馆选定角色卡的全部详细信息（描述、性格、场景、开场白、绑定世界书等）。',
        parameters: { type: 'object', properties: {} },
        action: async () => {
            const char = getCurrentCharacter();
            return JSON.stringify(char || { error: 'No character selected' });
        }
    },
    {
        name: 'st_get_persona',
        displayName: '读取当前用户设定',
        description: '读取当前酒馆用户的 Persona 人设描述及配置。',
        parameters: { type: 'object', properties: {} },
        action: async () => {
            const persona = getCurrentPersona();
            return JSON.stringify(persona);
        }
    },

    // --- LOREBOOK CREATION & CHARACTER BINDING TOOLS ---
    {
        name: 'st_create_and_bind_lorebook',
        displayName: '新建世界书并绑定到角色卡',
        description: '在 SillyTavern 中新建一本世界书并自动绑定到当前角色卡。支持同时打草稿写入工作区文件，并将条目推送至【待同步审核区】供用户审核确认。当用户要求“新建世界书并绑定”、“为本卡建设定集”、“打草稿后注入”时优先使用此工具。',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: '新世界书名称。若留空或未提供，将自动使用当前角色名（例如: "<角色名>_世界书"）'
                },
                bind_to_character: {
                    type: 'boolean',
                    description: '是否绑定到当前选中的角色卡。默认为 true'
                },
                bind_type: {
                    type: 'string',
                    enum: ['primary', 'additional'],
                    description: '绑定类型：primary (主世界书，默认) 或 additional (附加世界书)'
                },
                draft_path: {
                    type: 'string',
                    description: '可选。若提供，则同时在工作区草稿中创建该路径的文件（例如: "world/overview.md"）'
                },
                draft_content: {
                    type: 'string',
                    description: '可选。草稿文件的正文内容（当提供 draft_path 时写入）'
                },
                initial_entry: {
                    type: 'object',
                    description: '可选。推送到【待确认审核区】的首条条目对象',
                    properties: {
                        comment: { type: 'string', description: '条目标题/备注' },
                        content: { type: 'string', description: '条目内容（若留空且提供了 draft_path/draft_content，将自动引用草稿内容）' },
                        keys: { type: 'array', items: { type: 'string' }, description: '触发关键词' },
                        constant: { type: 'boolean', description: 'true=蓝灯(常驻生效无需触发词); false=绿灯(需关键词触发)，默认 true' },
                        enabled: { type: 'boolean', description: '是否启用条目，默认 true' },
                        order: { type: 'number', description: '插入顺序优先级，默认 100' },
                        position: { type: 'number', description: '插入位置 (0=前置角色, 1=后置角色, 2=前置AN, 3=后置AN, 4=按深度插入)' },
                        depth: { type: 'number', description: '深度插入深度 (默认 4)' }
                    }
                }
            }
        },
        action: async (args) => {
            const bind = args.bind_to_character !== false;
            const bindType = args.bind_type || 'primary';

            // 1. If draft_path & draft_content provided, write to workspace
            let writtenDraftPath = null;
            if (args.draft_path && args.draft_content !== undefined) {
                writeFile(args.draft_path, args.draft_content, 'overwrite');
                writtenDraftPath = args.draft_path;
            }

            // 2. Create world info and bind to character
            const res = await createAndBindWorldInfo({
                bookName: args.book_name,
                bind: bind,
                bindType: bindType
            });

            // 3. Push entry to Staging Area (审核区) so the user can review/approve
            let staged = null;
            if (args.initial_entry) {
                const ie = args.initial_entry;
                const entryContent = ie.content || (args.draft_path ? readFile(args.draft_path) : '') || '';
                const comment = ie.comment || (args.draft_path ? args.draft_path.split('/').pop().replace(/\.[^/.]+$/, '') : '初始设定');
                staged = addStagingEntry({
                    type: 'lorebook',
                    action: 'add',
                    target: res.bookName,
                    data: {
                        action: 'add',
                        comment: comment,
                        keys: ie.keys || [],
                        secondary_keys: ie.secondary_keys || [],
                        content: entryContent,
                        constant: ie.constant !== undefined ? ie.constant : true,
                        enabled: ie.enabled !== undefined ? ie.enabled : true,
                        order: ie.order ?? 100,
                        position: ie.position ?? 0,
                        depth: ie.depth ?? 4,
                    },
                    summary: `[世界书: ${res.bookName}] 新增条目: "${comment}"${args.draft_path ? ` (源于草稿: ${args.draft_path})` : ''}`
                });
            } else if (writtenDraftPath && args.draft_content) {
                const comment = writtenDraftPath.split('/').pop().replace(/\.[^/.]+$/, '');
                staged = addStagingEntry({
                    type: 'lorebook',
                    action: 'add',
                    target: res.bookName,
                    data: {
                        action: 'add',
                        comment: comment,
                        keys: [],
                        secondary_keys: [],
                        content: args.draft_content,
                        constant: true,
                        enabled: true,
                        order: 100,
                        position: 0,
                        depth: 4,
                    },
                    summary: `[世界书: ${res.bookName}] 新增条目: "${comment}" (源于草稿: ${writtenDraftPath})`
                });
            }

            // 4. Record History for undo/redo
            addHistoryRecord({
                type: 'lorebook',
                action: 'create_and_bind',
                target: res.bookName,
                summary: `新建世界书并绑定: 《${res.bookName}》${res.bound ? ` ➔ ${res.characterName || '当前角色'} (${res.bindType === 'additional' ? '附加世界书' : '主世界书'})` : ''}${writtenDraftPath ? ` (附草稿: ${writtenDraftPath})` : ''}`,
                beforeState: {
                    previousPrimary: res.previousPrimary,
                    previousBound: res.previousBound,
                    bindType: res.bindType
                },
                afterState: {
                    bookName: res.bookName,
                    bindType: res.bindType
                },
                canUndo: true,
            });

            return JSON.stringify({
                success: true,
                book_name: res.bookName,
                bound_to_character: res.bound,
                bind_type: res.bindType,
                character_name: res.characterName,
                draft_path: writtenDraftPath,
                staged_id: staged ? staged.id : null,
                message: `成功新建世界书《${res.bookName}》${res.bound ? `并已绑定为角色 [${res.characterName || '未知'}] 的${res.bindType === 'additional' ? '附加世界书' : '主世界书'}` : ''}！${writtenDraftPath ? `草稿已写入 [${writtenDraftPath}]。` : ''}${staged ? `条目 "${staged.data?.comment}" 已成功推送到【待确认审核区】，请在抽屉暂存区审核应用。` : ''}`
            });
        }
    },

    {
        name: 'st_delete_lorebook',
        displayName: '删除世界书(支持操作日志一键撤回)',
        description: '从 SillyTavern 中彻底删除指定的世界书文件，并自动解除当前角色卡及其他角色对该世界书的绑定。删除前会自动备份所有条目与绑定快照，支持在操作日志中一键撤回恢复。当用户要求“把世界书xxx删掉”、“删除某某世界书”或“清理当前绑定的世界书”时调用。',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: '要删除的世界书名称。若留空或未指定，默认自动解析当前选中的角色卡所绑定的主世界书。'
                },
                delete_workspace_drafts: {
                    type: 'boolean',
                    description: '可选。是否同步删除工作区草稿中对应的同名文件夹或草稿（默认为 false，安全保留草稿文件）。'
                }
            }
        },
        action: async (args) => {
            const res = await deleteWorldInfoSafely(args.book_name);

            // Optional: delete workspace drafts if requested
            let draftSummary = '';
            if (args.delete_workspace_drafts === true) {
                const files = listFiles();
                const matched = files.filter(f => f.path.startsWith(`world/${res.bookName}/`) || f.path === `world/${res.bookName}.md`);
                matched.forEach(f => deleteFile(f.path));
                if (matched.length > 0) {
                    draftSummary = `已同步清理工作区关联的 ${matched.length} 份草稿文件。`;
                }
            }

            // Record History for undo/redo
            addHistoryRecord({
                type: 'lorebook',
                action: 'delete_lorebook',
                target: res.bookName,
                summary: `删除世界书: 《${res.bookName}》 (含 ${res.entriesCount} 条设定条目)${draftSummary ? `，${draftSummary}` : ''}`,
                beforeState: res.backup,
                afterState: {
                    bookName: res.bookName
                },
                canUndo: true,
            });

            return JSON.stringify({
                success: true,
                book_name: res.bookName,
                entries_backed_up: res.entriesCount,
                message: `成功删除世界书《${res.bookName}》（原含 ${res.entriesCount} 条条目已自动备份快照，可随时在操作日志中一键撤回恢复）！${draftSummary}`
            });
        }
    },

    // --- ST STAGING TOOLS (STRICT WORKSPACE-FIRST DEPLOYMENT) ---
    {
        name: 'stage_lorebook_entry',
        displayName: '发布/删除世界书条目(强制from_file来源/支持frontmatter配置)',
        description: '准备添加、更新或删除一条世界书条目。除删除(delete)外，新增与更新必须指定工作区草稿路径 from_file（如 "lorebooks/书名/条目.md"），系统自动解析 YAML frontmatter（含 keys, constant, enabled, order, position 等）与正文，推送到审核区供确认生效。',
        parameters: {
            type: 'object',
            properties: {
                comment: { type: 'string', description: '条目标题/备注（索引名，必填）' },
                action: { type: 'string', enum: ['add', 'update', 'delete'], description: '操作类型：add (新增发布), update (更新发布), delete (删除下线)' },
                from_file: { type: 'string', description: '【必填(delete除外)】工作区草稿文件相对路径（如 "lorebooks/赛博设定集/义体改造.md"）' },
                target_book: { type: 'string', description: '目标世界书名称（可选，留空则自动使用当前角色绑定的专属世界书）' },
                keys: { type: 'array', items: { type: 'string' }, description: '可选。覆盖 frontmatter 中的主触发词' },
                secondary_keys: { type: 'array', items: { type: 'string' }, description: '可选。覆盖 frontmatter 中的次级触发词' },
                constant: { type: 'boolean', description: '可选。覆盖 frontmatter：true=蓝灯常驻, false=绿灯触发' },
                enabled: { type: 'boolean', description: '可选。覆盖 frontmatter：true=开启, false=关闭' },
                order: { type: 'number', description: '可选。覆盖 frontmatter 排序优先级 (默认 100)' },
                position: { type: 'number', description: '可选。覆盖 frontmatter 插入位置 (0=前置, 1=后置, 4=按深度)' },
                depth: { type: 'number', description: '可选。覆盖 frontmatter 插入深度' }
            },
            required: ['comment', 'action']
        },
        action: async (args) => {
            const isDelete = args.action === 'delete';
            let entryContent = '';
            let fmData = {};

            if (!isDelete) {
                if (!args.from_file) {
                    return JSON.stringify({
                        success: false,
                        error: '未指定 from_file！根据工区/酒馆职责分离规范，细致修改必须在工作区进行，发布必须提供 from_file 草稿路径（例如 "lorebooks/<书名>/<条目>.md"）。'
                    });
                }
                const fileText = readFile(args.from_file);
                if (fileText === null) {
                    return JSON.stringify({ success: false, error: `工作区草稿文件未找到: ${args.from_file}` });
                }
                const parsed = parseFrontmatter(fileText);
                fmData = parsed.data || {};
                entryContent = parsed.content || '';
            }

            const bound = getCharacterBoundLorebooks();
            const available = getAvailableWorldInfos();
            const targetBook = args.target_book || (bound.length > 0 ? bound[0] : (available.length > 0 ? available[0] : 'default'));

            const finalConstant = args.constant !== undefined ? args.constant : (fmData.constant !== undefined ? fmData.constant : true);
            const finalEnabled = args.enabled !== undefined ? args.enabled : (fmData.enabled !== undefined ? fmData.enabled : true);
            const finalKeys = Array.isArray(args.keys) ? args.keys : (Array.isArray(fmData.keys) ? fmData.keys : []);
            const finalSecondaryKeys = Array.isArray(args.secondary_keys) ? args.secondary_keys : (Array.isArray(fmData.secondary_keys) ? fmData.secondary_keys : []);
            const finalOrder = args.order !== undefined ? args.order : (fmData.order ?? 100);
            const finalPosition = args.position !== undefined ? args.position : (fmData.position ?? 0);
            const finalDepth = args.depth !== undefined ? args.depth : (fmData.depth ?? 4);

            const staged = addStagingEntry({
                type: 'lorebook',
                action: args.action,
                target: targetBook,
                data: {
                    action: args.action,
                    comment: args.comment,
                    keys: finalKeys,
                    secondary_keys: finalSecondaryKeys,
                    content: entryContent,
                    constant: finalConstant,
                    enabled: finalEnabled,
                    disable: !finalEnabled,
                    order: finalOrder,
                    position: finalPosition,
                    depth: finalDepth,
                },
                summary: `[世界书: ${targetBook}] ${args.action.toUpperCase()} 条目: "${args.comment}"${args.from_file ? ` (源于草稿: ${args.from_file})` : ''}`
            });

            return JSON.stringify({
                success: true,
                stagedId: staged.id,
                message: `成功将世界书条目 "${args.comment}" 的 ${args.action} 操作推送到【待确认审核区】！${args.from_file ? `（源于: ${args.from_file}）` : ''} 请在抽屉审核确认后生效。`
            });
        }
    },
    {
        name: 'stage_character_field',
        displayName: '发布角色卡字段修改(强制from_file来源)',
        description: '准备将工作区编辑好的角色卡草稿发布到当前角色卡。严格遵循工区精修规范，必须通过 from_file 指定草稿路径（如 "character/alice/description.md"），推送到暂存区供审核应用。',
        parameters: {
            type: 'object',
            properties: {
                field: {
                    type: 'string',
                    enum: ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt'],
                    description: '要更新的角色卡字段名（必填）'
                },
                from_file: {
                    type: 'string',
                    description: '【必填】工作区草稿文件路径，如 "character/alice/description.md"'
                },
                mode: {
                    type: 'string',
                    enum: ['replace', 'append'],
                    description: '更新模式：replace (全量覆盖，默认) 或 append (尾部追加)'
                }
            },
            required: ['field', 'from_file']
        },
        action: async (args) => {
            if (!args.from_file) {
                return JSON.stringify({
                    success: false,
                    error: '未指定 from_file！所有角色卡修改必须在工作区草稿中进行，请先用 workspace_patch 精修后再提供 from_file 同步。'
                });
            }

            const fieldContent = readFile(args.from_file);
            if (fieldContent === null) {
                return JSON.stringify({ success: false, error: `工作区草稿文件未找到: ${args.from_file}` });
            }

            const char = getCurrentCharacter();
            const charName = char ? char.name : 'Current Character';
            const staged = addStagingEntry({
                type: 'character',
                action: 'update',
                target: charName,
                data: {
                    [args.field]: fieldContent,
                    mode: args.mode || 'replace'
                },
                summary: `[角色卡: ${charName}] 更新字段 "${args.field}" (${args.mode || 'replace'}) (源于: ${args.from_file})`
            });

            return JSON.stringify({
                success: true,
                stagedId: staged.id,
                message: `已将角色卡字段 [${args.field}] 的更新推送到【待确认审核区】（源于: ${args.from_file}），请在抽屉暂存区审核确认。`
            });
        }
    },
    {
        name: 'stage_persona_field',
        displayName: '发布用户人设描述修改(强制from_file来源)',
        description: '准备将工作区编辑好的用户设定草稿发布到当前用户的 Persona。必须通过 from_file 指定草稿路径（如 "persona/default_user/description.md"），推送到暂存区供审核应用。',
        parameters: {
            type: 'object',
            properties: {
                from_file: {
                    type: 'string',
                    description: '【必填】工作区草稿文件路径，如 "persona/default_user/description.md"'
                },
                depth: { type: 'number', description: '可选。插入深度' },
                position: { type: 'number', description: '可选。插入位置' },
                mode: { type: 'string', enum: ['replace', 'append'], description: '替换或追加，默认 replace' }
            },
            required: ['from_file']
        },
        action: async (args) => {
            if (!args.from_file) {
                return JSON.stringify({
                    success: false,
                    error: '未指定 from_file！所有用户人设修改必须在工作区草稿中进行，请先用 workspace_patch 精修后再提供 from_file 同步。'
                });
            }

            const descContent = readFile(args.from_file);
            if (descContent === null) {
                return JSON.stringify({ success: false, error: `工作区草稿文件未找到: ${args.from_file}` });
            }

            const persona = getCurrentPersona();
            const staged = addStagingEntry({
                type: 'persona',
                action: 'update',
                target: persona.name,
                data: {
                    description: descContent,
                    depth: args.depth,
                    position: args.position,
                    mode: args.mode || 'replace'
                },
                summary: `[用户设定: ${persona.name}] 更新描述 (源于: ${args.from_file})`
            });

            return JSON.stringify({
                success: true,
                stagedId: staged.id,
                message: `已将用户设定描述更新推送到【待确认审核区】（源于: ${args.from_file}），请在抽屉暂存区审核确认。`
            });
        }
    },

    // --- REVERSE IMPORT TOOLS (PULL FROM ST INTO WORKSHOP) ---
    {
        name: 'st_import_lorebook_to_workspace',
        displayName: '将ST世界书导入工作区(方案C结构/每条目独立文件)',
        description: '将SillyTavern中已有的世界书完整导入到工作区草稿工坊中。采用方案C标准结构：lorebooks/<书名>/meta.json 存储全书级配置，每个条目拆解为一个独立的 <条目名>.md 文件（顶部带 YAML frontmatter 存储触发词与蓝绿灯属性，正文纯Markdown），便于后续用 workspace_patch 点对点精修。',
        parameters: {
            type: 'object',
            properties: {
                book_name: {
                    type: 'string',
                    description: '要导入的世界书名称（可选，留空则自动导入当前选中的角色卡所绑定的主世界书）'
                },
                folder_path: {
                    type: 'string',
                    description: '可选。自定义工作区目标文件夹路径，默认保存至: lorebooks/<书名>'
                }
            }
        },
        action: async (args) => {
            try {
                const res = await importLorebookToWorkspace({
                    bookName: args.book_name,
                    folderPath: args.folder_path
                });

                addHistoryRecord({
                    type: 'workspace',
                    action: 'import_lorebook',
                    target: res.folder,
                    summary: `导入世界书至工作区: 《${res.bookName}》 ➔ ${res.folder}/ (共 ${res.filesCount} 个文件)`,
                    beforeState: null,
                    afterState: { folder: res.folder, files: res.files },
                    canUndo: true,
                });

                return JSON.stringify({
                    success: true,
                    book_name: res.bookName,
                    folder: res.folder,
                    files_count: res.filesCount,
                    message: `成功将世界书《${res.bookName}》导入到工作区工坊 [${res.folder}/]！已生成 ${res.filesCount} 个草稿文件（含 meta.json 与各条目独立 .md）。\n` +
                             `后续指引：\n` +
                             `1. 可使用 [workspace_patch] 对各个条目 .md 进行无损差量点对点修改；\n` +
                             `2. 修改完毕后，调用 [stage_lorebook_entry(from_file="${res.folder}/<条目>.md", action="update")] 推送更新发布。`
                });
            } catch (e) {
                return JSON.stringify({ success: false, error: `导入世界书失败: ${e.message}` });
            }
        }
    },
    {
        name: 'st_import_character_to_workspace',
        displayName: '将当前角色卡设定导入工作区草稿',
        description: '将当前酒馆中选中的角色卡设定（描述 description、性格 personality、场景 scenario、开场白 first_mes 等）一键导出为工作区的模块化草稿文件（character/<角色名>/...），方便在工作区中精细研制与差量修改。',
        parameters: {
            type: 'object',
            properties: {
                folder_path: {
                    type: 'string',
                    description: '可选。自定义工作区目标文件夹路径，默认保存至: character/<角色名>'
                }
            }
        },
        action: async (args) => {
            try {
                const res = await importCharacterToWorkspace({ folderPath: args.folder_path });

                addHistoryRecord({
                    type: 'workspace',
                    action: 'import_character',
                    target: res.folder,
                    summary: `导入角色卡至工作区: [${res.characterName}] ➔ ${res.folder}/`,
                    beforeState: null,
                    afterState: { folder: res.folder, files: res.files },
                    canUndo: true,
                });

                return JSON.stringify({
                    success: true,
                    character_name: res.characterName,
                    folder: res.folder,
                    files_count: res.filesCount,
                    message: `成功将角色卡 [${res.characterName}] 的全套设定导入工作区工坊 [${res.folder}/]！\n` +
                             `后续指引：\n` +
                             `1. 可使用 [workspace_patch] 对 description.md、personality.md 等草稿做点对点微调；\n` +
                             `2. 修改完毕后，调用 [stage_character_field(field="description", from_file="${res.folder}/description.md")] 推送发布。`
                });
            } catch (e) {
                return JSON.stringify({ success: false, error: `导入角色卡失败: ${e.message}` });
            }
        }
    },
    {
        name: 'st_import_persona_to_workspace',
        displayName: '将当前用户人设导入工作区草稿',
        description: '将当前酒馆中用户的 Persona 人设描述与配置导出到工作区（persona/<用户名>/description.md 与 meta.json），方便在工作区进行持续迭代打磨。',
        parameters: {
            type: 'object',
            properties: {
                folder_path: {
                    type: 'string',
                    description: '可选。自定义工作区目标文件夹路径，默认保存至: persona/<用户名>'
                }
            }
        },
        action: async (args) => {
            try {
                const res = await importPersonaToWorkspace({ folderPath: args.folder_path });

                addHistoryRecord({
                    type: 'workspace',
                    action: 'import_persona',
                    target: res.folder,
                    summary: `导入用户设定至工作区: [${res.personaName}] ➔ ${res.folder}/`,
                    beforeState: null,
                    afterState: { folder: res.folder, files: res.files },
                    canUndo: true,
                });

                return JSON.stringify({
                    success: true,
                    persona_name: res.personaName,
                    folder: res.folder,
                    message: `成功将用户设定 [${res.personaName}] 导入工作区工坊 [${res.folder}/]！\n` +
                             `后续可用 [workspace_patch] 修改 description.md，改完后调用 [stage_persona_field(from_file="${res.folder}/description.md")] 发布。`
                });
            } catch (e) {
                return JSON.stringify({ success: false, error: `导入用户设定失败: ${e.message}` });
            }
        }
    },

    // --- WORKSPACE PATCH: SURGICAL FIND-AND-REPLACE & LINE-RANGE OVERWRITE & BATCH ---
    {
        name: 'workspace_patch',
        displayName: '工作区差量修改（支持批量合并 / 行号覆盖 / 四级容错搜索）',
        description: '对工作区已有草稿文件进行精准局部修改，彻底杜绝全量重写。\n' +
                     '【模式一：批量修改（多处修改强烈推荐！1次调用搞定所有修改）】传入 patches 数组：[{ start_line, end_line, replace }, ...] 或 [{ search, replace }, ...]，底层自动逆序原子合入，杜绝行号漂移与多次连环调用；\n' +
                     '【模式二：单处行号覆盖（大文件首选，0匹配失败）】传入 start_line, end_line 与 replace，直接就地覆盖指定行区间；\n' +
                     '【模式三：四级容错智能搜索】传入 search（或 find）与 replace，内置严格 ➔ 换行符归一 ➔ 首尾空行剥离 ➔ 缩进无关行匹配。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '目标草稿文件相对路径，如 "regex/状态栏/replace.html"' },
                patches: {
                    type: 'array',
                    description: '【批量模式推荐】同时修改多个位置的补丁列表。例如修改多个组件：[{"start_line": 120, "end_line": 125, "replace": "..."}, {"start_line": 200, "end_line": 205, "replace": "..."}]',
                    items: {
                        type: 'object',
                        properties: {
                            start_line: { type: 'integer', description: '起始行号' },
                            end_line: { type: 'integer', description: '结束行号' },
                            search: { type: 'string', description: '要搜索替换的原文本' },
                            find: { type: 'string', description: '同 search' },
                            replace: { type: 'string', description: '替换后的新文本' }
                        }
                    }
                },
                search: { type: 'string', description: '单处修改：要替换的原始文本片段（兼容 find）' },
                find: { type: 'string', description: '单处修改：同 search' },
                replace: { type: 'string', description: '单处修改：替换后的新文本内容' },
                start_line: { type: 'integer', description: '单处行号模式：起始行号（从 1 开始，需与 end_line 一起提供）' },
                end_line: { type: 'integer', description: '单处行号模式：结束行号（从 1 开始，包含该行）' },
                verify: { type: 'string', description: '单处修改可选：校验原文本切片（容忍空格与换行差异）' },
                all: { type: 'boolean', description: '若为 true，替换文件中所有匹配项；默认 false，只替换第一个匹配（仅单处搜索模式生效）' }
            },
            required: ['path']
        },
        action: async (args) => {
            const existing = readFile(args.path);
            if (existing === null) {
                return JSON.stringify({ success: false, error: `File not found: ${args.path}` });
            }

            // =========================================================
            // Mode A: Batch Patches Array (批量多处一次性修改)
            // =========================================================
            if (Array.isArray(args.patches) && args.patches.length > 0) {
                let docLines = existing.replace(/\r\n/g, '\n').split('\n');
                const appliedSummaries = [];

                const linePatches = [];
                const searchPatches = [];

                for (let i = 0; i < args.patches.length; i++) {
                    const p = args.patches[i];
                    const sLine = p.start_line !== undefined ? parseInt(p.start_line, 10) : null;
                    const eLine = p.end_line !== undefined ? parseInt(p.end_line, 10) : null;
                    if (sLine !== null && eLine !== null) {
                        linePatches.push({ ...p, sLine, eLine, index: i });
                    } else if (p.search !== undefined || p.find !== undefined) {
                        searchPatches.push({ ...p, index: i });
                    }
                }

                // Sort line patches descending (bottom to top) to prevent line drift
                linePatches.sort((a, b) => b.sLine - a.sLine);

                for (const p of linePatches) {
                    const total = docLines.length;
                    if (isNaN(p.sLine) || isNaN(p.eLine) || p.sLine < 1 || p.sLine > total || p.eLine < p.sLine || p.eLine > total) {
                        return JSON.stringify({
                            success: false,
                            error: `批量修改中第 ${p.index + 1} 项行号 [${p.sLine}, ${p.eLine}] 超出有效行数范围（当前总行数: ${total} 行）。`
                        });
                    }

                    const targetSlice = docLines.slice(p.sLine - 1, p.eLine).join('\n');
                    const verifyText = p.verify || p.search || p.find;
                    if (verifyText) {
                        const normVerify = verifyText.replace(/\r\n/g, '\n').trim().split('\n').map(l => l.trim()).join('\n');
                        const normTarget = targetSlice.trim().split('\n').map(l => l.trim()).join('\n');
                        if (normVerify !== normTarget && !normTarget.includes(normVerify)) {
                            return JSON.stringify({
                                success: false,
                                error: `批量修改中第 ${p.index + 1} 项校验未通过（行 ${p.sLine}-${p.eLine}）。目标代码可能已发生变更。`
                            });
                        }
                    }

                    const repLines = (p.replace !== undefined ? p.replace : '').replace(/\r\n/g, '\n').split('\n');
                    docLines.splice(p.sLine - 1, p.eLine - p.sLine + 1, ...repLines);
                    appliedSummaries.push(`行 ${p.sLine}-${p.eLine}`);
                }

                let textAfterLinePatches = docLines.join('\n');

                for (const p of searchPatches) {
                    const sTerm = p.search !== undefined ? p.search : p.find;
                    const rTerm = p.replace !== undefined ? p.replace : '';
                    if (!sTerm) continue;

                    if (textAfterLinePatches.includes(sTerm)) {
                        textAfterLinePatches = p.all ? textAfterLinePatches.split(sTerm).join(rTerm) : textAfterLinePatches.replace(sTerm, rTerm);
                        appliedSummaries.push(`搜索匹配项`);
                    } else {
                        const normText = textAfterLinePatches.replace(/\r\n/g, '\n');
                        const normSearch = sTerm.replace(/\r\n/g, '\n');
                        const normRep = rTerm.replace(/\r\n/g, '\n');
                        if (normText.includes(normSearch)) {
                            textAfterLinePatches = p.all ? normText.split(normSearch).join(normRep) : normText.replace(normSearch, normRep);
                            appliedSummaries.push(`容错搜索匹配项`);
                        } else {
                            return JSON.stringify({
                                success: false,
                                error: `批量修改中未能匹配搜索项: "${sTerm.substring(0, 30)}..."`
                            });
                        }
                    }
                }

                const patched = textAfterLinePatches;
                writeFile(args.path, patched, 'overwrite');

                addHistoryRecord({
                    type: 'workspace',
                    action: 'patch',
                    target: args.path,
                    summary: `批量差量修改 [${appliedSummaries.length} 处]: ${args.path}`,
                    beforeState: { content: existing },
                    afterState: { content: patched },
                    canUndo: true,
                });

                // Decouple diff from LLM return payload (stores in memory, returns zero-token diff_id)
                const diffId = storeDiff(existing, patched, `批量差量修改: ${args.path}`);

                return JSON.stringify({
                    success: true,
                    path: args.path,
                    mode: `batch (${appliedSummaries.length} patches)`,
                    applied_count: appliedSummaries.length,
                    diff_id: diffId,
                    summary: `成功一次性完成 ${appliedSummaries.length} 处批量差量修改（修改范围: ${appliedSummaries.slice(0, 5).join(', ')}${appliedSummaries.length > 5 ? ' 等' : ''}）`
                });
            }

            // =========================================================
            // Single Patch Modes (Mode B: Line-Range, Mode C: Search)
            // =========================================================
            const sLine = args.start_line !== undefined ? parseInt(args.start_line, 10) : null;
            const eLine = args.end_line !== undefined ? parseInt(args.end_line, 10) : null;
            const docLines = existing.replace(/\r\n/g, '\n').split('\n');
            const totalLines = docLines.length;

            let patched = null;
            let patchMode = '';
            let tierUsed = null;
            let targetOldSlice = '';

            // Mode B: Line-Range Direct Replacement
            if (sLine !== null && eLine !== null) {
                if (isNaN(sLine) || isNaN(eLine) || sLine < 1 || sLine > totalLines || eLine < sLine || eLine > totalLines) {
                    return JSON.stringify({
                        success: false,
                        error: `指定的行号区间 [${sLine}, ${eLine}] 无效，当前文件总行数为 ${totalLines} 行。`
                    });
                }

                const targetSliceLines = docLines.slice(sLine - 1, eLine);
                targetOldSlice = targetSliceLines.join('\n');

                const verifyText = args.verify || args.search || args.find;
                if (verifyText) {
                    const normVerify = verifyText.replace(/\r\n/g, '\n').trim();
                    const normTarget = targetOldSlice.trim();
                    const verifyTrimmed = normVerify.split('\n').map(l => l.trim()).join('\n');
                    const targetTrimmed = normTarget.split('\n').map(l => l.trim()).join('\n');

                    if (normVerify !== normTarget && verifyTrimmed !== targetTrimmed && !targetTrimmed.includes(verifyTrimmed)) {
                        return JSON.stringify({
                            success: false,
                            error: `行号 [${sLine}-${eLine}] 内容校验未通过！文件可能已被其他操作改动。请先调用 workspace_read 查看最新切片后再提交。`
                        });
                    }
                }

                const replaceLines = (args.replace !== undefined ? args.replace : '').replace(/\r\n/g, '\n').split('\n');
                docLines.splice(sLine - 1, eLine - sLine + 1, ...replaceLines);
                patched = docLines.join('\n');
                patchMode = `line_range (行 ${sLine}-${eLine})`;
            } else {
                // Mode C: Multi-tier Tolerant Search & Replace
                const searchTerm = args.search !== undefined ? args.search : args.find;
                if (searchTerm === undefined || searchTerm === null) {
                    return JSON.stringify({
                        success: false,
                        error: '必须提供 "patches" 批量数组，或 "search"/"find" 参数，或 "start_line" 与 "end_line" 行号区间。'
                    });
                }

                const replaceText = args.replace !== undefined ? args.replace : '';

                // Tier 1: Exact Match
                if (existing.includes(searchTerm)) {
                    patched = args.all ? existing.split(searchTerm).join(replaceText) : existing.replace(searchTerm, replaceText);
                    patchMode = 'exact_match';
                    tierUsed = 1;
                    targetOldSlice = searchTerm;
                } else {
                    // Tier 2: CRLF Normalization Match
                    const normExisting = existing.replace(/\r\n/g, '\n');
                    const normSearch = searchTerm.replace(/\r\n/g, '\n');
                    const normReplace = replaceText.replace(/\r\n/g, '\n');

                    if (normExisting.includes(normSearch)) {
                        patched = args.all ? normExisting.split(normSearch).join(normReplace) : normExisting.replace(normSearch, normReplace);
                        patchMode = 'crlf_normalized';
                        tierUsed = 2;
                        targetOldSlice = normSearch;
                    } else {
                        // Tier 3: Trimmed Search Block Match
                        const trimmedSearch = normSearch.trim();
                        if (trimmedSearch.length > 0 && normExisting.includes(trimmedSearch)) {
                            const matchCount = normExisting.split(trimmedSearch).length - 1;
                            if (matchCount === 1 || args.all) {
                                patched = args.all
                                    ? normExisting.split(trimmedSearch).join(normReplace)
                                    : normExisting.replace(trimmedSearch, normReplace);
                                patchMode = 'trimmed_block';
                                tierUsed = 3;
                                targetOldSlice = trimmedSearch;
                            }
                        }

                        // Tier 4: Line-by-Line Indentation-Insensitive Match
                        if (!patched) {
                            const searchRawLines = normSearch.split('\n');
                            while (searchRawLines.length > 0 && searchRawLines[0].trim() === '') searchRawLines.shift();
                            while (searchRawLines.length > 0 && searchRawLines[searchRawLines.length - 1].trim() === '') searchRawLines.pop();

                            if (searchRawLines.length > 0) {
                                const trimmedSearchLines = searchRawLines.map(l => l.trim());
                                const candidateMatches = [];

                                for (let i = 0; i <= docLines.length - searchRawLines.length; i++) {
                                    let matched = true;
                                    for (let j = 0; j < searchRawLines.length; j++) {
                                        if (docLines[i + j].trim() !== trimmedSearchLines[j]) {
                                            matched = false;
                                            break;
                                        }
                                    }
                                    if (matched) {
                                        candidateMatches.push({ start: i, count: searchRawLines.length });
                                        if (!args.all && candidateMatches.length > 1) break;
                                    }
                                }

                                if (candidateMatches.length === 1 || (args.all && candidateMatches.length > 0)) {
                                    const repLines = normReplace.split('\n');
                                    const targetMatches = args.all ? [...candidateMatches].reverse() : candidateMatches;
                                    for (const m of targetMatches) {
                                        targetOldSlice = docLines.slice(m.start, m.start + m.count).join('\n');
                                        docLines.splice(m.start, m.count, ...repLines);
                                    }
                                    patched = docLines.join('\n');
                                    patchMode = 'indentation_insensitive';
                                    tierUsed = 4;
                                }
                            }
                        }
                    }
                }

                if (!patched) {
                    const firstSearchLine = (searchTerm || '').split(/\r?\n/).find(l => l.trim().length > 0) || '';
                    const partialHints = firstSearchLine ? searchFiles(firstSearchLine.trim().substring(0, 30), { path: args.path }) : [];
                    let hintMsg = '';
                    if (partialHints.length > 0 && partialHints[0].matches?.length > 0) {
                        const linesFound = partialHints[0].matches.map(m => `第 ${m.line} 行`).slice(0, 3).join('、');
                        hintMsg = `（启发提示：类似代码片段可能位于 ${linesFound}，建议使用 start_line 与 end_line 指定行号区间直接替换，或调用 workspace_read 查看该行切片）`;
                    }
                    return JSON.stringify({
                        success: false,
                        error: `在 ${args.path} 中未能找到匹配的搜索文本（已尝试严格匹配、换行符规整、空行剥离与缩进容错 4 级匹配）。${hintMsg}`
                    });
                }
            }

            writeFile(args.path, patched, 'overwrite');
            addHistoryRecord({
                type: 'workspace',
                action: 'patch',
                target: args.path,
                summary: `差量修改 [${patchMode}]: ${args.path} (${(args.replace?.length || 0) - (targetOldSlice ? targetOldSlice.length : 0)} 字符)`,
                beforeState: { content: existing },
                afterState: { content: patched },
                canUndo: true,
            });

            // Zero-token diff decoupling
            const diffId = storeDiff(existing, patched, `修改对比: ${args.path}`);

            return JSON.stringify({
                success: true,
                path: args.path,
                mode: patchMode,
                diff_id: diffId,
                tier: tierUsed || undefined,
                summary: `修改成功 [${patchMode}]：已保存变更至草稿`
            });
        }
    },
    ...createRegexToolDefinitions({ addStagingEntry, addHistoryRecord })
];

export function isToolEnabled(toolName) {
    const settings = getSettings();
    if (!settings.enabledTools) return true;
    return settings.enabledTools[toolName] !== false;
}

export function setToolEnabled(toolName, enabled) {
    const settings = getSettings();
    if (!settings.enabledTools) settings.enabledTools = {};
    settings.enabledTools[toolName] = !!enabled;
    saveWorkspace();

    if (settings.toolMode === 'native' && ToolManager) {
        if (enabled) {
            const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
            if (tool && typeof ToolManager.registerFunctionTool === 'function') {
                try {
                    ToolManager.registerFunctionTool({
                        name: tool.name,
                        displayName: tool.displayName,
                        description: tool.description,
                        parameters: tool.parameters,
                        action: tool.action,
                    });
                } catch (e) {
                    console.warn(`[Worldlore Agent] Could not register tool ${tool.name}:`, e);
                }
            }
        } else {
            if (typeof ToolManager.unregisterFunctionTool === 'function') {
                try { ToolManager.unregisterFunctionTool(toolName); } catch (_) {}
            }
        }
    }
}

export function registerAllToolsWithToolManager() {
    const settings = getSettings();
    if (settings.toolMode !== 'native') return; // text mode: do not register with ToolManager
    if (ToolManager && typeof ToolManager.registerFunctionTool === 'function') {
        for (const tool of TOOL_DEFINITIONS) {
            if (!isToolEnabled(tool.name)) {
                try { ToolManager.unregisterFunctionTool(tool.name); } catch (_) {}
                continue;
            }
            try {
                ToolManager.registerFunctionTool({
                    name: tool.name,
                    displayName: tool.displayName,
                    description: tool.description,
                    parameters: tool.parameters,
                    action: tool.action,
                });
            } catch (e) {
                console.warn(`[Worldlore Agent] Could not register tool ${tool.name} with ToolManager:`, e);
            }
        }
        console.log('[Worldlore Agent] Registered active tools with ST ToolManager (native mode)');
    }
}

export function unregisterAllTools() {
    if (ToolManager && typeof ToolManager.unregisterFunctionTool === 'function') {
        for (const tool of TOOL_DEFINITIONS) {
            try { ToolManager.unregisterFunctionTool(tool.name); } catch (_) {}
        }
        console.log('[Worldlore Agent] Unregistered all tools from ST ToolManager');
    }
}

/**
 * Switch tool mode at runtime. 'native' = native Function Calling; 'text' = <agent_action> tags only.
 * @param {'native'|'text'} mode
 */
export function setToolMode(mode) {
    const settings = getSettings();
    settings.toolMode = mode;
    saveWorkspace();
    if (mode === 'native') {
        registerAllToolsWithToolManager();
    } else {
        unregisterAllTools();
    }
    console.log(`[Worldlore Agent] Switched to ${mode.toUpperCase()} mode`);
}

export const TEXT_MODE_TOOL_DEFS = {
    write: [
        {
            name: 'st_create_and_bind_lorebook',
            desc: '新建世界书并绑定到当前角色卡',
            params: [
                { name: 'book_name', type: 'string', req: '可选', desc: '世界书名称（留空则按当前角色名命名）' },
                { name: 'bind_to_character', type: 'boolean', req: '可选', def: 'true', desc: '是否绑定当前角色卡' },
                { name: 'bind_type', type: 'string', req: '可选', def: '"primary"', desc: '"primary" 主世界书 | "additional" 附加世界书' },
                { name: 'draft_path', type: 'string', req: '可选', desc: '工作区草稿路径' },
                { name: 'draft_content', type: 'string', req: '可选', desc: '草稿正文' },
                { name: 'initial_entry', type: 'object', req: '可选', desc: '推送至待确认审核区的首条条目' }
            ]
        },
        {
            name: 'st_import_lorebook_to_workspace',
            desc: '将酒馆中的世界书按方案C拆解导入工作区（独立.md带frontmatter属性）',
            params: [
                { name: 'book_name', type: 'string', req: '可选', desc: '要导入的世界书名称（留空则导入当前角色绑定的主世界书）' }
            ]
        },
        {
            name: 'stage_lorebook_entry',
            desc: '推送世界书条目变更到待确认审核区（从工作区草稿推送）',
            params: [
                { name: 'action', type: 'string', req: '必填', desc: '操作类型: "create" 新建 | "update" 更新 | "delete" 删除' },
                { name: 'from_file', type: 'string', req: '条件必填', desc: '工作区草稿文件相对路径（action为create/update时必填）' },
                { name: 'book_name', type: 'string', req: '可选', desc: '目标世界书名称（留空则使用当前角色绑定的主世界书）' },
                { name: 'comment', type: 'string', req: '条件必填', desc: '目标条目标题（未提供entry_id时通过标题匹配）' },
                { name: 'entry_id', type: 'integer', req: '可选', desc: '目标条目ID' }
            ]
        },
        {
            name: 'st_delete_lorebook',
            desc: '从酒馆彻底删除指定世界书并自动解除绑定',
            params: [
                { name: 'book_name', type: 'string', req: '必填', desc: '要删除的世界书名称' }
            ]
        },
        {
            name: 'st_import_character_to_workspace',
            desc: '将当前角色的各字段设定拆解导入工作区',
            params: [
                { name: 'character_name', type: 'string', req: '可选', desc: '角色名称（留空则默认当前角色卡）' }
            ]
        },
        {
            name: 'stage_character_field',
            desc: '推送角色卡字段修改到待确认审核区（从工作区草稿推送）',
            params: [
                { name: 'field', type: 'string', req: '必填', desc: '角色字段: "description" | "personality" | "scenario" | "first_mes" | "mes_example" | "system_prompt" | "creator_notes"' },
                { name: 'from_file', type: 'string', req: '必填', desc: '工作区草稿文件相对路径' },
                { name: 'character_name', type: 'string', req: '可选', desc: '目标角色名（留空则默认当前角色）' }
            ]
        },
        {
            name: 'st_import_persona_to_workspace',
            desc: '将当前用户的人设设定导入工作区',
            params: [
                { name: 'persona_name', type: 'string', req: '可选', desc: '用户名（留空则默认当前选中用户）' }
            ]
        },
        {
            name: 'stage_persona_field',
            desc: '推送用户人设描述修改到待确认审核区（从工作区草稿推送）',
            params: [
                { name: 'from_file', type: 'string', req: '必填', desc: '工作区草稿文件相对路径' },
                { name: 'persona_name', type: 'string', req: '可选', desc: '目标用户名（留空则默认当前用户）' }
            ]
        },
        {
            name: 'st_import_regex_to_workspace',
            desc: '将酒馆中的正则脚本拆解导入到工作区（纯代码replace.html与meta.json）',
            params: [
                { name: 'script_name', type: 'string', req: '必填', desc: '要导出的正则脚本名称' },
                { name: 'scope', type: 'string', req: '可选', def: '"all"', desc: '检索范围: "character" | "preset" | "global" | "all"' }
            ]
        },
        {
            name: 'st_install_regex_from_file',
            desc: '从工作区安装部署正则脚本到酒馆（推入待确认审核区）',
            params: [
                { name: 'from_folder', type: 'string', req: '必填', desc: '工作区正则目录路径（如 "regex/状态栏"）' },
                { name: 'scope', type: 'string', req: '可选', def: '"character"', desc: '安装范围: "character" | "preset" | "global"' },
                { name: 'replace_existing', type: 'boolean', req: '可选', def: 'true', desc: '是否覆盖同名正则' }
            ]
        },
        {
            name: 'st_delete_regex_script',
            desc: '从酒馆中删除指定的正则脚本',
            params: [
                { name: 'script_name', type: 'string', req: '必填', desc: '要删除的正则脚本名称' },
                { name: 'scope', type: 'string', req: '可选', def: '"character"', desc: '删除范围: "character" | "preset" | "global"' }
            ]
        },
        {
            name: 'workspace_patch',
            desc: '精准差量修改工作区草稿（首选！支持批量修改、行号覆盖或四级容错搜索）',
            params: [
                { name: 'path', type: 'string', req: '必填', desc: '工作区文件相对路径' },
                { name: 'patches', type: 'array', req: '可选', desc: '【批量模式首选！】多处修改列表，一次调用合入所有修改：[{ start_line, end_line, replace }, ...]' },
                { name: 'replace', type: 'string', req: '条件必填', desc: '单处修改：替换后的新文本内容' },
                { name: 'start_line', type: 'integer', req: '可选', desc: '单处行号模式：起始行号（大文件首选）' },
                { name: 'end_line', type: 'integer', req: '可选', desc: '单处行号模式：结束行号' },
                { name: 'search', type: 'string', req: '可选', desc: '单处搜索模式：要查找被替换的文本（兼容 find）' },
                { name: 'verify', type: 'string', req: '可选', desc: '校验原文本切片' },
                { name: 'all', type: 'boolean', req: '可选', def: 'false', desc: '是否替换全部匹配' }
            ]
        },
        {
            name: 'workspace_write',
            desc: '全量创建或覆写工作区草稿文件',
            params: [
                { name: 'path', type: 'string', req: '必填', desc: '工作区文件相对路径' },
                { name: 'content', type: 'string', req: '必填', desc: '文件完整正文' },
                { name: 'mode', type: 'string', req: '可选', def: '"overwrite"', desc: '"overwrite" 覆写 | "append" 追加' }
            ]
        },
        {
            name: 'workspace_delete',
            desc: '删除工作区草稿文件（记录审计日志，支持撤回）',
            params: [
                { name: 'path', type: 'string', req: '必填', desc: '要删除的文件相对路径' }
            ]
        },
        {
            name: 'workspace_rename',
            desc: '重命名工作区中的草稿文件（记录审计日志，支持撤回）',
            params: [
                { name: 'old_path', type: 'string', req: '必填', desc: '原草稿文件相对路径' },
                { name: 'new_path', type: 'string', req: '必填', desc: '新草稿文件相对路径' }
            ]
        },
        {
            name: 'workspace_rename_project',
            desc: '重命名写卡工作区/项目名称（记录审计日志，支持撤回）',
            params: [
                { name: 'new_name', type: 'string', req: '必填', desc: '新工作区项目名称' },
                { name: 'old_name', type: 'string', req: '可选', desc: '原工作区项目名称（留空默认当前工作区）' }
            ]
        }
    ],
    read: [
        {
            name: 'st_get_lorebooks_overview',
            desc: '查看酒馆中所有可用世界书及当前角色与聊天绑定关系',
            params: []
        },
        {
            name: 'st_read_lorebook',
            desc: '读取指定世界书的条目列表与详细设定',
            params: [
                { name: 'book_name', type: 'string', req: '可选', desc: '世界书名称（留空则读取当前角色主世界书）' },
                { name: 'search', type: 'string', req: '可选', desc: '关键词过滤条目' },
                { name: 'limit', type: 'integer', req: '可选', def: '30', desc: '返回条目最大数量' }
            ]
        },
        {
            name: 'st_get_character',
            desc: '读取当前角色卡全部设定详情与元数据',
            params: [
                { name: 'field', type: 'string', req: '可选', desc: '指定获取单一字段，留空返回全部' }
            ]
        },
        {
            name: 'st_get_persona',
            desc: '读取当前选中用户的 Persona 设定与描述',
            params: [
                { name: 'persona_name', type: 'string', req: '可选', desc: '用户名（留空则默认当前选中用户）' }
            ]
        },
        {
            name: 'st_list_regex_scripts',
            desc: '列出酒馆中已安装的正则脚本列表',
            params: [
                { name: 'scope', type: 'string', req: '可选', def: '"all"', desc: '范围: "character" | "preset" | "global" | "all"' }
            ]
        },
        {
            name: 'st_test_regex_script',
            desc: '在沙盒中测试正则替换效果（不修改酒馆）',
            params: [
                { name: 'find_regex', type: 'string', req: '必填', desc: '正则表达式查找模式' },
                { name: 'replace_string', type: 'string', req: '必填', desc: '替换内容' },
                { name: 'test_text', type: 'string', req: '必填', desc: '待测试的目标文本' }
            ]
        },
        {
            name: 'workspace_read',
            desc: '读取工作区草稿文件内容（支持按行切片极速读取）',
            params: [
                { name: 'path', type: 'string', req: '必填', desc: '工作区文件相对路径' },
                { name: 'start_line', type: 'integer', req: '可选', desc: '起始行号（从 1 开始，大文件建议切片读取）' },
                { name: 'end_line', type: 'integer', req: '可选', desc: '结束行号（从 1 开始）' }
            ]
        },
        {
            name: 'workspace_list',
            desc: '列出工作区当前项目的所有文件与大小',
            params: [
                { name: 'filter', type: 'string', req: '可选', desc: '路径过滤前缀' }
            ]
        },
        {
            name: 'workspace_search',
            desc: '在工作区草稿中全文搜索关键词（返回精确行号 line 与代码摘要）',
            params: [
                { name: 'query', type: 'string', req: '必填', desc: '搜索关键词' },
                { name: 'path', type: 'string', req: '可选', desc: '限制只在指定的单个文件内检索' }
            ]
        }
    ]
};

/**
 * Generates the clean text-mode prompt containing strictly the example and dynamically enabled tools.
 * Only active when extension is enabled and current mode is 'text'. In 'native' mode returns empty string.
 * @param {boolean} [force=false] If true, bypasses mode check (for manual copy button)
 */
export function getTextModeToolsPrompt(force = false) {
    const settings = getSettings();
    if (!force) {
        if (settings.enabled === false) {
            return '';
        }
    }

    const mode = settings.toolMode || 'native';
    if (mode === 'native') {
        return `<tools>\n 模型支持原生Function Calling，你可以直接调用对应工具\n</tools>`;
    }

    const writeLines = [];
    const readLines = [];

    for (const tool of TEXT_MODE_TOOL_DEFS.write) {
        if (!isToolEnabled(tool.name)) continue;
        writeLines.push(`    - ${tool.name}: ${tool.desc}`);
        for (const p of tool.params) {
            const defStr = p.def !== undefined ? `, 默认 ${p.def}` : '';
            writeLines.push(`        ${p.name}: (${p.type}, ${p.req}${defStr}) ${p.desc}`);
        }
    }

    for (const tool of TEXT_MODE_TOOL_DEFS.read) {
        if (!isToolEnabled(tool.name)) continue;
        readLines.push(`    - ${tool.name}: ${tool.desc}`);
        for (const p of tool.params) {
            const defStr = p.def !== undefined ? `, 默认 ${p.def}` : '';
            readLines.push(`        ${p.name}: (${p.type}, ${p.req}${defStr}) ${p.desc}`);
        }
    }

    if (writeLines.length === 0 && readLines.length === 0) {
        return '';
    }

    let body = `<agent_action name="工具名称">\n{\n  "参数1": "值1",\n  "参数2": "值2"\n}\n</agent_action>\n\n\ntool_list:\n`;
    if (writeLines.length > 0) {
        body += `  write:\n` + writeLines.join('\n') + '\n';
    }
    if (readLines.length > 0) {
        body += `  read:\n` + readLines.join('\n') + '\n';
    }

    return `<tools>\n禁止使用原生 Function Calling，所有工具调用必须通过在回复末尾附加 <agent_action> 标签来执行。\n\n${body.trimEnd()}\n</tools>`;
}

export function getToolDocumentationPrompt(force = false) {
    return getTextModeToolsPrompt(force);
}
