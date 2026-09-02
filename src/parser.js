import { TOOL_DEFINITIONS } from './tools.js';
import { getSettings } from './workspace.js';

const toolsMap = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]));

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
                const toolName = parsed.action || parsed.tool;
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
    const tool = toolsMap.get(name);
    if (!tool) {
        console.warn(`[Worldlore Agent] Unknown tool called: ${name}`);
        return { success: false, error: `Unknown tool: ${name}` };
    }
    try {
        console.log(`[Worldlore Agent] Executing tool ${name}:`, args);
        const result = await tool.action(args);
        return { success: true, result };
    } catch (e) {
        console.error(`[Worldlore Agent] Error executing tool ${name}:`, e);
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
        badge.innerHTML = `
            <i class="fa-solid fa-${item.result.success ? 'bolt' : 'triangle-exclamation'}"></i>
            <span><strong>${item.toolName}</strong>: ${item.params.from_file || item.params.path || item.params.comment || item.params.field || item.params.query || item.params.book_name || item.params.scope || 'executed'}</span>
            <span class="badge-status">${item.result.success ? '✓' : '✗'}</span>
        `;
        badgeContainer.appendChild(badge);
    }

    messageElement.appendChild(badgeContainer);
}
