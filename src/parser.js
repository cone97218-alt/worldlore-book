import { TOOL_DEFINITIONS } from './tools.js';
import { getSettings } from './workspace.js';
import { getContext } from '/scripts/extensions.js';
import { Generate } from '/script.js';
import { sendNarratorMessage } from '/scripts/slash-commands.js';
import { showDiffModal } from './diff.js';

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
};

const READ_TOOLS = new Set([
    'st_get_character',
    'st_get_persona',
    'st_read_lorebook',
    'st_get_lorebooks_overview',
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
    const resolvedName = TOOL_ALIASES[name] || name;
    const tool = toolsMap.get(resolvedName);
    if (!tool) {
        console.warn(`[Worldlore Agent] Unknown tool called: ${name}`);
        return { success: false, error: `Unknown tool: ${name}` };
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
        const iconClass = !item.result.success ? 'triangle-exclamation' : (isDelete ? 'trash-can' : (isCreateWi ? 'book-bookmark' : 'bolt'));
        const paramSummary = item.params.book_name || item.params.from_file || item.params.path || item.params.comment || item.params.field || item.params.query || item.params.scope || 'executed';

        badge.innerHTML = `
            <i class="fa-solid fa-${iconClass}"></i>
            <span><strong>${item.toolName}</strong>: ${paramSummary}</span>
            <span class="badge-status">${item.result.success ? '✓' : '✗'}</span>
        `;

        // If tool result contains a diff (e.g. workspace_patch or workspace_write modification), attach a Diff button
        let parsedResult = null;
        try {
            parsedResult = typeof item.result.result === 'string' ? JSON.parse(item.result.result) : item.result.result;
        } catch (_) {}

        if (parsedResult?.diff) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'worldlore-badge-feed-btn';
            diffBtn.setAttribute('title', '查看修改对比 (Diff)');
            diffBtn.innerHTML = '<i class="fa-solid fa-code-compare"></i>';
            diffBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showDiffModal(`修改对比: ${parsedResult.path || item.params.path || '草稿文件'}`, parsedResult.diff.oldText, parsedResult.diff.newText);
            });
            badge.appendChild(diffBtn);
        }

        // If this is a read tool and succeeded, attach a "Feed & Continue" pure FA button
        if (item.result.success && READ_TOOLS.has(item.toolName)) {
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
