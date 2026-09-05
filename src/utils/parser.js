import { TOOL_DEFINITIONS, isToolEnabled } from '../tools/index.js';
import { getSettings } from '../core/workspace.js';
import { getContext } from '/scripts/extensions.js';
import { Generate } from '/script.js';
import { sendNarratorMessage } from '/scripts/slash-commands.js';
import { showDiffModal, getStoredDiff } from './diff.js';

const toolsMap = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]));

const TOOL_ALIASES = {
    'create_and_bind_lorebook': 'st_create_and_bind_lorebook',
    'create_worldbook': 'st_create_and_bind_lorebook',
    'st_create_lorebook': 'st_create_and_bind_lorebook',
    'create_lorebook': 'st_create_and_bind_lorebook',
    'delete_lorebook': 'st_delete_lorebook',
    'delete_worldbook': 'st_delete_lorebook',
    'st_delete_worldbook': 'st_delete_lorebook',
    'remove_lorebook': 'st_delete_lorebook',
    'st_remove_lorebook': 'st_delete_lorebook',
    'delete_draft': 'workspace_delete',
    'delete_file': 'workspace_delete',
    'remove_draft': 'workspace_delete',
    'remove_file': 'workspace_delete',
    'rename_draft': 'workspace_rename',
    'rename_file': 'workspace_rename',
    'workspace_rename_file': 'workspace_rename',
    'rename_project': 'workspace_rename_project',
    'rename_workspace': 'workspace_rename_project',
    'workspace_rename_workspace': 'workspace_rename_project',
    'write_draft': 'workspace_write',
    'write_file': 'workspace_write',
    'read_draft': 'workspace_read',
    'read_file': 'workspace_read',
    'patch_draft': 'workspace_patch',
    'patch_file': 'workspace_patch',
    'search_draft': 'workspace_search',
    'search_workspace': 'workspace_search',
    'list_drafts': 'workspace_list',
    'list_files': 'workspace_list',
    'list_regex_scripts': 'st_list_regex_scripts',
    'list_regex': 'st_list_regex_scripts',
    'delete_regex_script': 'st_delete_regex_script',
    'import_regex': 'st_import_regex_to_workspace',
    'import_regex_script': 'st_import_regex_to_workspace',
    'import_lorebook': 'st_import_lorebook_to_workspace',
    'import_worldbook': 'st_import_lorebook_to_workspace',
    'import_character': 'st_import_character_to_workspace',
    'import_persona': 'st_import_persona_to_workspace',
    'install_regex': 'st_install_regex_from_file',
    'test_regex': 'st_test_regex_script',
    'test_regex_script': 'st_test_regex_script',
    'get_character': 'st_get_character',
    'get_character_info': 'st_get_character',
    'read_character': 'st_get_character',
    'get_persona': 'st_get_persona',
    'get_persona_info': 'st_get_persona',
    'read_persona': 'st_get_persona',
    'read_lorebook': 'st_read_lorebook',
    'read_worldbook': 'st_read_lorebook',
    'get_lorebooks_overview': 'st_get_lorebooks_overview',
    'lorebooks_overview': 'st_get_lorebooks_overview',
};

const READ_TOOLS = new Set([
    'st_get_character',
    'st_get_persona',
    'st_read_lorebook',
    'st_get_lorebooks_overview',
    'st_list_regex_scripts',
    'st_test_regex_script',
    'st_import_lorebook_to_workspace',
    'st_import_character_to_workspace',
    'st_import_persona_to_workspace',
    'st_import_regex_to_workspace',
    'workspace_read',
    'workspace_search',
    'workspace_list'
]);

export async function parseAndExecuteActions(text, messageElement) {
    if (!text || typeof text !== 'string') return [];
    
    // Check if extension is enabled
    const settings = getSettings();
    if (settings.enabled === false) return [];

    const executed = [];

    // Format 1: <agent_action name="...">...</agent_action>
    const tagRegex = /<agent_action\s+name=["']([^"']+)["']>([\s\S]*?)<\/agent_action>/gi;
    let match;
    while ((match = tagRegex.exec(text)) !== null) {
        const toolName = match[1].trim();
        const rawParams = match[2].trim();
        let params = {};
        try {
            params = JSON.parse(rawParams);
        } catch (e) {
            console.warn(`[Worldlore Agent] Failed to parse JSON params for ${toolName}:`, rawParams);
        }

        const res = await executeToolByName(toolName, params);
        executed.push({ toolName, params, result: res });
    }

    // Format 2: ```action or ```json with "action" property
    const jsonBlockRegex = /```(?:json|action)\s*\n([\s\S]*?)\n```/gi;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed && (parsed.action || parsed.tool)) {
                const rawName = parsed.action || parsed.tool;
                const toolName = TOOL_ALIASES[rawName] || rawName;
                const params = parsed.params || parsed.args || parsed.parameters || parsed;
                if (toolsMap.has(toolName)) {
                    const res = await executeToolByName(toolName, params);
                    executed.push({ toolName, params, result: res });
                }
            }
        } catch (e) {
            // Not a tool json, ignore
        }
    }

    if (executed.length > 0 && messageElement) {
        renderExecutionBadge(messageElement, executed);
    }

    return executed;
}

export async function executeToolByName(name, args) {
    const settings = getSettings();
    if (settings.enabled === false) {
        console.warn(`[Worldlore Agent] Extension is disabled. Skipping execution of "${name}".`);
        return { success: false, error: 'A助手扩展当前处于禁用状态。' };
    }

    const resolvedName = TOOL_ALIASES[name] || name;
    const tool = toolsMap.get(resolvedName);
    if (!tool) {
        console.warn(`[Worldlore Agent] Unknown tool called: ${name}`);
        return { success: false, error: `Unknown tool: ${name}` };
    }
    if (!isToolEnabled(resolvedName)) {
        console.warn(`[Worldlore Agent] Tool "${resolvedName}" is disabled in settings.`);
        return { success: false, error: `工具 "${resolvedName}" 已在扩展设置中被禁用。` };
    }
    try {
        console.log(`[Worldlore Agent] Executing tool ${resolvedName}:`, args);
        const result = await tool.action(args);
        return { success: true, result };
    } catch (e) {
        console.error(`[Worldlore Agent] Error executing tool ${resolvedName}:`, e);
        return { success: false, error: e.message };
    }
}

function renderExecutionBadge(messageElement, executedList) {
    const existing = messageElement.querySelector('.worldlore-execution-badges');
    if (existing) existing.remove();

    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'worldlore-execution-badges';

    for (const item of executedList) {
        const badge = document.createElement('div');
        badge.className = `worldlore-badge ${item.result.success ? 'success' : 'error'}`;
        const isCreateWi = item.toolName === 'st_create_and_bind_lorebook' || TOOL_ALIASES[item.toolName] === 'st_create_and_bind_lorebook';
        const isDelete = item.toolName === 'st_delete_lorebook' || item.toolName === 'workspace_delete' || TOOL_ALIASES[item.toolName] === 'st_delete_lorebook' || TOOL_ALIASES[item.toolName] === 'workspace_delete';
        const isRename = item.toolName === 'workspace_rename' || item.toolName === 'workspace_rename_project' || TOOL_ALIASES[item.toolName] === 'workspace_rename' || TOOL_ALIASES[item.toolName] === 'workspace_rename_project';
        const iconClass = !item.result.success ? 'triangle-exclamation' : (isDelete ? 'trash-can' : (isRename ? 'pen-to-square' : (isCreateWi ? 'book-bookmark' : 'bolt')));
        const paramSummary = (item.params.old_path && item.params.new_path ? `${item.params.old_path} ➔ ${item.params.new_path}` : (item.params.old_name && item.params.new_name ? `${item.params.old_name} ➔ ${item.params.new_name}` : (item.params.new_name || item.params.new_path))) || item.params.book_name || item.params.from_file || item.params.path || item.params.comment || item.params.field || item.params.query || item.params.scope || 'executed';

        badge.innerHTML = `
            <i class="fa-solid fa-${iconClass}"></i>
            <span><strong>${item.toolName}</strong>: ${paramSummary}</span>
            <span class="badge-status">${item.result.success ? '✓' : '✗'}</span>
        `;

        // If tool result contains a diff or diff_id (e.g. workspace_patch or workspace_write modification), attach a Diff button
        let parsedResult = null;
        try {
            parsedResult = typeof item.result.result === 'string' ? JSON.parse(item.result.result) : item.result.result;
        } catch (_) {}

        const diffId = parsedResult?.diff_id;
        const stored = diffId ? getStoredDiff(diffId) : null;
        const hasDiff = stored || parsedResult?.diff;

        if (hasDiff) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'worldlore-badge-feed-btn';
            diffBtn.setAttribute('title', '查看修改对比 (Diff)');
            diffBtn.innerHTML = '<i class="fa-solid fa-code-compare"></i>';
            diffBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const oldText = stored?.oldText || parsedResult?.diff?.oldText || '';
                const newText = stored?.newText || parsedResult?.diff?.newText || '';
                const title = stored?.title || `修改对比: ${parsedResult.path || item.params.path || '草稿文件'}`;
                showDiffModal(title, oldText, newText);
            });
            badge.appendChild(diffBtn);
        }

        // If this is a read tool and succeeded, attach a "Feed & Continue" pure FA button
        const resolvedToolName = TOOL_ALIASES[item.toolName] || item.toolName;
        if (item.result.success && READ_TOOLS.has(resolvedToolName)) {
            const feedBtn = document.createElement('button');
            feedBtn.className = 'worldlore-badge-feed-btn';
            feedBtn.setAttribute('title', '将读取结果回传给AI并继续生成');
            feedBtn.innerHTML = '<i class="fa-solid fa-forward-step"></i>';

            feedBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (feedBtn.disabled) return;
                feedBtn.disabled = true;
                feedBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                try {
                    // Clean up any undefined/null chat items that might have been accidentally created
                    const context = getContext();
                    if (Array.isArray(context.chat)) {
                        for (let i = context.chat.length - 1; i >= 0; i--) {
                            if (!context.chat[i]) {
                                context.chat.splice(i, 1);
                            }
                        }
                    }

                    const textPayload = typeof item.result.result === 'string'
                        ? item.result.result
                        : JSON.stringify(item.result.result, null, 2);
                    const msg = `[A助手·数据回传: ${item.toolName}]\n${textPayload}`;
                    
                    await sendNarratorMessage({ compact: 'true' }, msg);
                    toastr.success('已回传数据，AI 正在继续生成...');
                    feedBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    await Generate('normal');
                } catch (err) {
                    console.error('[Worldlore Agent] Error feeding result to AI:', err);
                    toastr.error('回传失败: ' + err.message);
                    feedBtn.disabled = false;
                    feedBtn.innerHTML = '<i class="fa-solid fa-forward-step"></i>';
                }
            });

            badge.appendChild(feedBtn);
        }

        badgeContainer.appendChild(badge);
    }

    messageElement.appendChild(badgeContainer);
}
