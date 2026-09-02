import { eventSource, event_types } from '/script.js';
import { getSettings, readFile } from './workspace.js';
import { getCurrentCharacter, getCurrentPersona, readLorebookEntriesScoped } from './st-sync.js';

/**
 * Expands concise reference tags (e.g. [草稿: world/xxx.md]) in text into their full actual content.
 * Designed to expand only in the outgoing LLM prompt without polluting UI/input box.
 * 
 * @param {string} text
 * @returns {string}
 */
export function expandReferencesInText(text) {
    if (!text || typeof text !== 'string') return text;

    // 1. Expand Draft Files: [草稿: world/雾潮纪元.md]
    text = text.replace(/\[草稿:\s*([^\]]+)\]/g, (match, filePath) => {
        const trimmedPath = filePath.trim();
        const content = readFile(trimmedPath);
        if (content !== null && content !== undefined) {
            return `[草稿: ${trimmedPath}]\n<referenced_file path="${trimmedPath}">\n${content}\n</referenced_file>`;
        }
        return match;
    });

    // 2. Expand Character Fields: [角色设定: 角色名.field]
    text = text.replace(/\[角色设定:\s*([^\]]+)\]/g, (match, expr) => {
        const trimmedExpr = expr.trim();
        const dotIdx = trimmedExpr.lastIndexOf('.');
        const fieldKey = dotIdx !== -1 ? trimmedExpr.substring(dotIdx + 1).trim() : trimmedExpr;
        const char = getCurrentCharacter();
        if (char && char[fieldKey] !== undefined && char[fieldKey] !== null) {
            return `[角色设定: ${trimmedExpr}]\n<referenced_character_field field="${fieldKey}">\n${char[fieldKey]}\n</referenced_character_field>`;
        }
        return match;
    });

    // 3. Expand Persona Fields: [用户设定: 用户名.field]
    text = text.replace(/\[用户设定:\s*([^\]]+)\]/g, (match, expr) => {
        const trimmedExpr = expr.trim();
        const dotIdx = trimmedExpr.lastIndexOf('.');
        const fieldKey = dotIdx !== -1 ? trimmedExpr.substring(dotIdx + 1).trim() : trimmedExpr;
        const persona = getCurrentPersona();
        if (persona && persona[fieldKey] !== undefined && persona[fieldKey] !== null) {
            return `[用户设定: ${trimmedExpr}]\n<referenced_persona_field field="${fieldKey}">\n${persona[fieldKey]}\n</referenced_persona_field>`;
        }
        return match;
    });

    // 4. Expand Lorebook Entries: [世界书条目: book > comment]
    text = text.replace(/\[世界书条目:\s*([^\]]+)\]/g, (match, expr) => {
        const parts = expr.split('>').map(s => s.trim());
        const bookName = parts.length > 1 ? parts[0] : null;
        const commentName = parts.length > 1 ? parts[1] : parts[0];
        try {
            const res = readLorebookEntriesScoped('active');
            const entry = (res?.entries || []).find(e => 
                (!bookName || e.book === bookName) && (e.comment === commentName || e.comment?.trim() === commentName)
            );
            if (entry && entry.content) {
                return `[世界书条目: ${expr.trim()}]\n<referenced_lorebook_entry book="${entry.book}" comment="${entry.comment}">\n${entry.content}\n</referenced_lorebook_entry>`;
            }
        } catch (e) {
            console.warn('[Worldlore Agent] Error expanding lorebook reference:', e);
        }
        return match;
    });

    return text;
}

/**
 * Initializes listeners to dynamically inject referenced content before sending to LLM.
 */
export function initPromptInjector() {
    // 1. Hook into Chat Completion prompt ready event (OpenAI, Claude, DeepSeek, etc.)
    if (eventSource && event_types?.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
            const settings = getSettings();
            if (settings.enabled === false) return;
            if (!eventData || !Array.isArray(eventData.chat)) return;

            for (const msg of eventData.chat) {
                if (!msg) continue;
                if (typeof msg.content === 'string') {
                    msg.content = expandReferencesInText(msg.content);
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part && typeof part.text === 'string') {
                            part.text = expandReferencesInText(part.text);
                        }
                    }
                }
            }
        });
    }

    // 2. Hook into Text Completion prompt ready event (Kobold, TextGen text mode, etc.)
    if (eventSource && event_types?.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (eventData) => {
            const settings = getSettings();
            if (settings.enabled === false) return;
            if (!eventData || typeof eventData.prompt !== 'string') return;

            eventData.prompt = expandReferencesInText(eventData.prompt);
        });
    }

    console.log('[Worldlore Agent] Prompt reference injector initialized.');
}
