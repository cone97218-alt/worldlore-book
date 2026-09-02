import { getContext } from '/scripts/extensions.js';
import { ToolManager } from '/scripts/tool-calling.js';
import { getSettings, saveWorkspace, writeFile, readFile, deleteFile, listFiles, searchFiles } from './workspace.js';
import { applyWorldInfoEntry, applyCharacterFieldUpdate, applyPersonaFieldUpdate, getAvailableWorldInfos, getCharacterBoundLorebooks, getCurrentCharacter, getCurrentPersona, getLorebooksOverview, readLorebookEntriesScoped } from './st-sync.js';

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
        if (item.beforeState?.content === null || item.beforeState?.content === undefined) {
            deleteFile(item.target);
        } else {
            writeFile(item.target, item.beforeState.content, 'overwrite');
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
        if (item.afterState?.content !== undefined) {
            writeFile(item.target, item.afterState.content, 'overwrite');
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
            return JSON.stringify({ success: true, message: `Successfully wrote ${res.path} (${res.length} chars)` });
        }
    },
    {
        name: 'workspace_read',
        displayName: '工作区读取文件',
        description: '读取工作区中指定草稿文件的内容。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件相对路径' }
            },
            required: ['path']
        },
        action: async (args) => {
            const content = readFile(args.path);
            if (content === null) {
                return JSON.stringify({ success: false, error: `File not found: ${args.path}` });
            }
            return JSON.stringify({ success: true, path: args.path, content });
        }
    },
    {
        name: 'workspace_search',
        displayName: '工作区搜索设定',
        description: '在工作区所有草稿中全文搜索关键词，返回匹配的文件路径及文本摘要。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' }
            },
            required: ['query']
        },
        action: async (args) => {
            const results = searchFiles(args.query);
            return JSON.stringify({ success: true, query: args.query, matchesCount: results.length, results });
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

    // --- ST STAGING TOOLS (ZERO-OVERHEAD DIRECT PIPE & AD-HOC) ---
    {
        name: 'stage_lorebook_entry',
        displayName: '暂存世界书条目变更(支持from_file直接导入/蓝绿灯/顺序等)',
        description: '准备添加、修改或删除一条世界书条目（支持蓝灯常驻/绿灯触发constant、条目开启/关闭enabled、排序优先级order、插入位置position、深度depth等）。若草稿已在工作区中，请直接提供 from_file 路径（无需重复在 content 中传输长文本），实现零 Token 开销直通暂存！',
        parameters: {
            type: 'object',
            properties: {
                comment: { type: 'string', description: '条目标题/备注（必填，作为索引名）' },
                action: { type: 'string', enum: ['add', 'update', 'delete'], description: '操作类型：add (新增), update (修改), delete (删除)' },
                from_file: { type: 'string', description: '【推荐】直接引用工作区已有草稿文件路径（如 "world/magic.md"），插件直接读取，无需在 content 中传输全文！' },
                content: { type: 'string', description: '条目正文提示词（若未指定 from_file 时使用）' },
                keys: { type: 'array', items: { type: 'string' }, description: '主触发词列表（如 ["魔法", "咒语"]）' },
                secondary_keys: { type: 'array', items: { type: 'string' }, description: '次级触发词列表' },
                target_book: { type: 'string', description: '目标世界书名称（可选，留空则自动写入当前角色绑定的专属世界书）' },
                constant: { type: 'boolean', description: '【模式】true=蓝灯(常驻生效无需触发词); false=绿灯(需关键词触发)' },
                enabled: { type: 'boolean', description: '【开关】true=开启(启用条目); false=关闭(禁用条目)' },
                order: { type: 'number', description: '【顺序】排序优先级 (数字越大越优先，默认 100)' },
                position: { type: 'number', description: '【插入位置】0=前置角色定义, 1=后置角色定义, 2=前置AN, 3=后置AN, 4=按深度插入, 5=前置示例, 6=后置示例' },
                depth: { type: 'number', description: '【插入深度】当 position=4 时的插入深度 (默认 4)' },
                role: { type: 'number', description: '【插入角色】0=System, 1=User, 2=Assistant' },
                selective_logic: { type: 'number', description: '【次级逻辑】0=AND ANY, 1=NOT ANY, 2=NOT ALL, 3=AND ALL' },
                probability: { type: 'number', description: '【触发概率】0~100 (默认 100)' }
            },
            required: ['comment', 'action']
        },
        action: async (args) => {
            let entryContent = args.content || '';
            if (args.from_file) {
                const fileText = readFile(args.from_file);
                if (fileText === null) {
                    return JSON.stringify({ success: false, error: `Referenced file not found: ${args.from_file}` });
                }
                entryContent = fileText;
            }

            const bound = getCharacterBoundLorebooks();
            const available = getAvailableWorldInfos();
            const targetBook = args.target_book || (bound.length > 0 ? bound[0] : (available.length > 0 ? available[0] : 'default'));
            const staged = addStagingEntry({
                type: 'lorebook',
                action: args.action,
                target: targetBook,
                data: {
                    action: args.action,
                    comment: args.comment,
                    keys: args.keys,
                    secondary_keys: args.secondary_keys,
                    content: entryContent,
                    constant: args.constant,
                    enabled: args.enabled,
                    disable: args.disable !== undefined ? args.disable : (args.enabled !== undefined ? !args.enabled : undefined),
                    order: args.order,
                    position: args.position,
                    depth: args.depth,
                    role: args.role,
                    selective_logic: args.selective_logic,
                    probability: args.probability,
                    sticky: args.sticky,
                    cooldown: args.cooldown,
                },
                summary: `[世界书: ${targetBook}] ${args.action.toUpperCase()} 条目: "${args.comment}"${args.from_file ? ` (源于: ${args.from_file})` : ''}`
            });
            return JSON.stringify({ success: true, stagedId: staged.id, message: `Staged lorebook entry: ${args.comment} (${args.action}) for [${targetBook}] directly${args.from_file ? ` from [${args.from_file}]` : ''}. Awaiting user confirmation in drawer staging.` });
        }
    },
    {
        name: 'stage_character_field',
        displayName: '暂存角色卡字段修改(支持from_file直接导入)',
        description: '准备修改当前选中的角色卡字段（描述、性格、开场白、对话示例等）。支持通过 from_file 直接导入工作区草稿，推送到待确认暂存区供用户审核。',
        parameters: {
            type: 'object',
            properties: {
                field: {
                    type: 'string',
                    enum: ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt'],
                    description: '要修改的角色卡字段名'
                },
                from_file: { type: 'string', description: '【推荐】直接引用工作区已有草稿文件路径，无需传输长文本' },
                content: { type: 'string', description: '新内容（若未指定 from_file 时使用）' },
                mode: { type: 'string', enum: ['replace', 'append'], description: '替换或追加，默认为 replace' }
            },
            required: ['field']
        },
        action: async (args) => {
            let fieldContent = args.content || '';
            if (args.from_file) {
                const fileText = readFile(args.from_file);
                if (fileText === null) {
                    return JSON.stringify({ success: false, error: `Referenced file not found: ${args.from_file}` });
                }
                fieldContent = fileText;
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
                summary: `[角色卡: ${charName}] 更新字段 "${args.field}" (${args.mode || 'replace'})${args.from_file ? ` (源于: ${args.from_file})` : ''}`
            });
            return JSON.stringify({ success: true, stagedId: staged.id, message: `Staged character field update: ${args.field}${args.from_file ? ` from [${args.from_file}]` : ''}. Awaiting user confirmation in drawer staging.` });
        }
    },
    {
        name: 'stage_persona_field',
        displayName: '暂存用户描述修改',
        description: '准备修改当前用户的 Persona 描述，推送到待确认暂存区供用户审核应用。',
        parameters: {
            type: 'object',
            properties: {
                from_file: { type: 'string', description: '可选。直接引用工作区已有草稿文件路径' },
                description: { type: 'string', description: '用户人设描述内容' },
                depth: { type: 'number', description: '插入深度' },
                position: { type: 'number', description: '插入位置' },
                mode: { type: 'string', enum: ['replace', 'append'], description: '替换或追加' }
            }
        },
        action: async (args) => {
            let descContent = args.description || '';
            if (args.from_file) {
                const fileText = readFile(args.from_file);
                if (fileText !== null) descContent = fileText;
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
                summary: `[用户设定: ${persona.name}] 更新用户描述. Awaiting user confirmation in drawer staging.`
            });
            return JSON.stringify({ success: true, stagedId: staged.id, message: `Staged persona description update` });
        }
    },
    {
        name: 'st_set_lorebook_entry_state',
        displayName: '快速调整世界书蓝灯/绿灯/开启/关闭/顺序',
        description: '快速修改已有世界书条目的模式(蓝灯/绿灯)、开关(开启/关闭)与顺序 order，推送到暂存区审核。',
        parameters: {
            type: 'object',
            properties: {
                comment: { type: 'string', description: '条目标题/索引名称（必填）' },
                target_book: { type: 'string', description: '目标世界书（留空默认当前角色绑定世界书）' },
                constant: { type: 'boolean', description: '【模式】true=蓝灯(常驻); false=绿灯(触发)' },
                enabled: { type: 'boolean', description: '【开关】true=开启; false=关闭' },
                order: { type: 'number', description: '【顺序】排序优先级 (默认 100)' },
                position: { type: 'number', description: '【插入位置】0=前置, 1=后置, 4=按深度' },
                depth: { type: 'number', description: '【插入深度】默认 4' }
            },
            required: ['comment']
        },
        action: async (args) => {
            const bound = getCharacterBoundLorebooks();
            const available = getAvailableWorldInfos();
            const targetBook = args.target_book || (bound.length > 0 ? bound[0] : (available.length > 0 ? available[0] : 'default'));
            const staged = addStagingEntry({
                type: 'lorebook',
                action: 'update',
                target: targetBook,
                data: {
                    action: 'update',
                    comment: args.comment,
                    constant: args.constant,
                    enabled: args.enabled,
                    disable: args.enabled !== undefined ? !args.enabled : undefined,
                    order: args.order,
                    position: args.position,
                    depth: args.depth,
                },
                summary: `[世界书: ${targetBook}] 调整状态: "${args.comment}" (${args.constant !== undefined ? (args.constant ? '蓝灯' : '绿灯') : '灯光保持'}, ${args.enabled !== undefined ? (args.enabled ? '开启' : '关闭') : '开关保持'}, 顺序:${args.order ?? '保持'})`
            });
            return JSON.stringify({ success: true, stagedId: staged.id, message: `Staged state update for entry "${args.comment}".` });
        }
    },

    // --- WORKSPACE PATCH: SURGICAL FIND-AND-REPLACE ---
    {
        name: 'workspace_patch',
        displayName: '工作区差量修改（精准搜索替换）',
        description: '对工作区已有草稿文件进行精准局部修改，只传入要替换的原文片段（search）和新内容（replace），插件直接在文件内原地替换，无需传输全文。适合小范围改动（改名称/调数值/修一句话），彻底杜绝版本滚雪球和全量重写。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '目标草稿文件相对路径，如 "world/magic.md"' },
                search: { type: 'string', description: '要替换的原始文本片段（需精确匹配文件中对应字符，包括换行与缩进）' },
                replace: { type: 'string', description: '替换后的新文本内容' },
                all: { type: 'boolean', description: '若为 true，替换文件中所有匹配项；默认 false，只替换第一个匹配' }
            },
            required: ['path', 'search', 'replace']
        },
        action: async (args) => {
            const existing = readFile(args.path);
            if (existing === null) {
                return JSON.stringify({ success: false, error: `File not found: ${args.path}` });
            }
            if (!existing.includes(args.search)) {
                return JSON.stringify({ success: false, error: `Search text not found in ${args.path}. Verify exact text including whitespace and line breaks.` });
            }
            const patched = args.all
                ? existing.split(args.search).join(args.replace)
                : existing.replace(args.search, args.replace);
            writeFile(args.path, patched, 'overwrite');
            addHistoryRecord({
                type: 'workspace',
                action: 'patch',
                target: args.path,
                summary: `差量修改: ${args.path} (-${args.search.length}c +${args.replace.length}c)`,
                beforeState: { content: existing },
                afterState: { content: patched },
                canUndo: true,
            });
            return JSON.stringify({
                success: true,
                path: args.path,
                removed_chars: args.search.length,
                added_chars: args.replace.length,
                delta: args.replace.length - args.search.length
            });
        }
    }
];

export function registerAllToolsWithToolManager() {
    const settings = getSettings();
    if (settings.toolMode !== 'native') return; // text mode: do not register with ToolManager
    if (ToolManager && typeof ToolManager.registerFunctionTool === 'function') {
        for (const tool of TOOL_DEFINITIONS) {
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
        console.log('[Worldlore Agent] Registered all tools with ST ToolManager (native mode)');
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

export function getToolDocumentationPrompt() {
    const settings = getSettings();
    const isTextMode = settings.toolMode === 'text';

    const modeHeader = isTextMode
        ? `### A助手 (Worldlore Agent) 工具指令说明 【文本模式】

\u26a0\ufe0f **当前为文本模式（Text Mode）**：禁止使用原生 Function Calling，所有工具调用必须通过在回复末尾附加 \`<agent_action>\` 标签来执行。

格式：
\`\`\`xml
<agent_action name="工具名称">
{
  "参数1": "值1",
  "参数2": "值2"
}
</agent_action>
\`\`\`

多个工具调用时，逐个追加多个标签。**不要在对话正文中复述标签内容。**`
        : `### A助手 (Worldlore Agent) 工具指令说明 【原生模式】

你可以通过执行动作来在工作区管理设定草稿、查阅不同范围的世界书（角色/聊天/全局/指定书名）、以及向暂存区提交世界书/角色卡/用户描述的修改。
直接调用对应的原生 Function Calling 工具即可。`;

    const toolList = `
#### 核心提效规则 (Token Optimization Rules)：
- **小范围改动优先用 \`workspace_patch\`**：若用户只要求修改几个词、一句话或一个数值，**禁止重写整个草稿文件**。直接用 \`workspace_patch(path, search, replace)\` 传入原文片段与新内容，零全文传输。
- **禁止重复搬运已存在的草稿**：草稿已在工作区且需同步到世界书时，直接传 \`from_file\`，严禁先 \`workspace_read\` 读出再往 \`content\` 填入。
- **严禁在对话回复中复述长文本**：写入/修改完成后，对话只需简述操作结果（文件名与改动摘要），不打印正文。

#### 可用工具列表：

1. **\`stage_lorebook_entry\`**：暂存世界书条目变更（支持从草稿直通导入）
   - \`comment\`: (string, 必填) 条目标题/备注（索引名）
   - \`action\`: (string, 必填) "add" | "update" | "delete"
   - \`from_file\`: (string, 极力推荐) 直接指定工作区草稿文件相对路径（如 "world/magic.md"），无需传输正文！
   - \`content\`: (string) 条目正文内容（仅当没有 from_file 时使用）
   - \`target_book\`: (string, 可选) 目标世界书名（留空默认当前角色绑定世界书）
   - \`constant\`: (boolean, 可选) 【模式】true=蓝灯(常驻生效无需触发词); false=绿灯(需关键词触发)
   - \`enabled\`: (boolean, 可选) 【开关】true=开启(启用条目); false=关闭(禁用条目)
   - \`order\`: (number, 可选) 排序优先级 (默认 100)
   - \`position\`: (number, 可选) 0=前置角色定义, 1=后置角色定义, 2=前置AN, 3=后置AN, 4=按深度插入
   - \`depth\`: (number, 可选) 当 position=4 时的插入深度 (默认 4)
   - \`keys\`: (array of string, 可选) 触发词列表

2. **\`stage_character_field\`**：暂存角色卡字段修改（支持 from_file）
   - \`field\`: (string, 必填) "description" | "personality" | "scenario" | "first_mes" | "mes_example" | "creator_notes"
   - \`from_file\`: (string, 极力推荐) 直接指定工作区草稿路径，零 Token 搬运
   - \`content\`: (string) 内容
   - \`mode\`: (string, 可选) "replace" | "append" (默认 "replace")

3. **\`stage_persona_field\`**：暂存用户 Persona 描述修改（支持 from_file）

4. **\`st_set_lorebook_entry_state\`**：快速调整世界书条目的蓝灯/绿灯/开启/关闭/顺序
   - \`comment\`: (string) 条目标题
   - \`constant\`: (boolean) 蓝灯/绿灯
   - \`enabled\`: (boolean) 开启/关闭
   - \`order\`: (number) 顺序

5. **\`workspace_write\`**：创建/更新工作区草稿文件（全量写入，适合新建文件或大幅重构）
   - \`path\`: (string) 路径，例如 "world/magic.md"
   - \`content\`: (string) 正文内容
   - \`mode\`: (string, 可选) "overwrite" | "append" | "create"

6. **\`workspace_patch\`**：工作区差量修改（精准搜索替换，**小改动首选**）
   - \`path\`: (string) 目标草稿文件相对路径
   - \`search\`: (string, 必填) 要替换的原始文本片段（精确匹配，含换行与缩进）
   - \`replace\`: (string, 必填) 替换后的新内容
   - \`all\`: (boolean, 可选) true=替换所有匹配，false=只替换第一个（默认）

7. **\`workspace_read\`**：读取工作区草稿（仅在需要查阅用户手写的未知历史文件时调用）

8. **\`workspace_search\`**：在工作区中搜索设定

9. **\`workspace_list\`**：列出工作区草稿列表

10. **\`st_read_lorebook\`**：读取已有世界书条目（支持 scope 与 book_name）

11. **\`st_get_lorebooks_overview\`**：查看酒馆世界书全景（角色绑定、聊天绑定、全局激活）

12. **\`st_get_character\`**：读取当前角色卡全部字段详情

13. **\`st_get_persona\`**：读取当前用户的 Persona 设定
`;

    return modeHeader + '\n' + toolList;
}
