import { eventSource, event_types } from '/script.js';
import { getSettings, readFile } from './workspace.js';
import { getCurrentCharacter, getCurrentPersona, readLorebookEntriesScoped } from './st-sync.js';

/**
 * Expands concise reference tags (e.g. [草稿: world/xxx.md]) in text into their full actual content.
 * Wraps referenced materials in <add-info>...</add-info> OUTSIDE <user_input>, so file contents
 * are not treated as the user's spoken dialogue.
 * 
 * @param {string} text
 * @returns {string}
 */
export function expandReferencesInText(text) {
    if (!text || typeof text !== 'string') return text;

    const refPattern = /\[(草稿|草稿名|草稿全文|角色设定|角色设定名|角色设定全文|用户设定|用户设定名|用户设定全文|世界书条目|世界书条目名|世界书条目全文):\s*([^\]]+)\]/g;
    const matches = [...text.matchAll(refPattern)];
    if (matches.length === 0) return text;

    const settings = getSettings();
    const globalIsNameOnly = settings.qrReferenceMode === 'name';
    const extractedItems = [];

    for (const match of matches) {
        const fullTag = match[0];
        const refType = match[1];
        let refArg = match[2].trim();

        // Check if argument contains suffix like (仅名) or (仅名称) or (全文)
        let localMode = null;
        if (/\((?:仅名|仅名称|name)\)$/i.test(refArg)) {
            refArg = refArg.replace(/\((?:仅名|仅名称|name)\)$/i, '').trim();
            localMode = 'name';
        } else if (/\((?:全文|full)\)$/i.test(refArg)) {
            refArg = refArg.replace(/\((?:全文|full)\)$/i, '').trim();
            localMode = 'full';
        }

        const isNameOnly = localMode === 'name' || refType.endsWith('名') || (localMode !== 'full' && !refType.endsWith('全文') && globalIsNameOnly);

        if (refType.startsWith('草稿')) {
            if (isNameOnly) {
                extractedItems.push({
                    fullTag,
                    header: `[草稿: ${refArg}]`,
                    content: `<referenced_file path="${refArg}" mode="name_only" />`
                });
            } else {
                const content = readFile(refArg);
                if (content !== null && content !== undefined) {
                    extractedItems.push({
                        fullTag,
                        header: `[草稿: ${refArg}]`,
                        content: `<referenced_file path="${refArg}">\n${content}\n</referenced_file>`
                    });
                }
            }
        } else if (refType.startsWith('角色设定')) {
            const dotIdx = refArg.lastIndexOf('.');
            const fieldKey = dotIdx !== -1 ? refArg.substring(dotIdx + 1).trim() : refArg;
            const char = getCurrentCharacter();
            if (isNameOnly) {
                extractedItems.push({
                    fullTag,
                    header: `[角色设定: ${refArg}]`,
                    content: `<referenced_character_field field="${fieldKey}" mode="name_only" />`
                });
            } else if (char && char[fieldKey] !== undefined && char[fieldKey] !== null) {
                extractedItems.push({
                    fullTag,
                    header: `[角色设定: ${refArg}]`,
                    content: `<referenced_character_field field="${fieldKey}">\n${char[fieldKey]}\n</referenced_character_field>`
                });
            }
        } else if (refType.startsWith('用户设定')) {
            const dotIdx = refArg.lastIndexOf('.');
            const fieldKey = dotIdx !== -1 ? refArg.substring(dotIdx + 1).trim() : refArg;
            const persona = getCurrentPersona();
            if (isNameOnly) {
                extractedItems.push({
                    fullTag,
                    header: `[用户设定: ${refArg}]`,
                    content: `<referenced_persona_field field="${fieldKey}" mode="name_only" />`
                });
            } else if (persona && persona[fieldKey] !== undefined && persona[fieldKey] !== null) {
                extractedItems.push({
                    fullTag,
                    header: `[用户设定: ${refArg}]`,
                    content: `<referenced_persona_field field="${fieldKey}">\n${persona[fieldKey]}\n</referenced_persona_field>`
                });
            }
        } else if (refType.startsWith('世界书条目')) {
            const parts = refArg.split('>').map(s => s.trim());
            const bookName = parts.length > 1 ? parts[0] : null;
            const commentName = parts.length > 1 ? parts[1] : parts[0];
            if (isNameOnly) {
                extractedItems.push({
                    fullTag,
                    header: `[世界书条目: ${refArg}]`,
                    content: `<referenced_lorebook_entry ${bookName ? `book="${bookName}" ` : ''}comment="${commentName}" mode="name_only" />`
                });
            } else {
                try {
                    const res = readLorebookEntriesScoped('active');
                    const entry = (res?.entries || []).find(e =>
                        (!bookName || e.book === bookName) && (e.comment === commentName || e.comment?.trim() === commentName)
                    );
                    if (entry && entry.content) {
                        extractedItems.push({
                            fullTag,
                            header: `[世界书条目: ${refArg}]`,
                            content: `<referenced_lorebook_entry book="${entry.book}" comment="${entry.comment}">\n${entry.content}\n</referenced_lorebook_entry>`
                        });
                    }
                } catch (e) {
                    console.warn('[Worldlore Agent] Error reading lorebook reference:', e);
                }
            }
        }
    }

    if (extractedItems.length === 0) return text;

    // 1. Remove all reference tags from the user input message
    let cleanedText = text;
    for (const item of extractedItems) {
        cleanedText = cleanedText.replaceAll(item.fullTag, '');
    }

    // 2. Clean up <user_input> if present
    cleanedText = cleanedText.replace(/<user_input>([\s\S]*?)<\/user_input>/g, (m, inner) => {
        const trimmed = inner.replace(/^\s*\n+|\n+\s*$/g, '').trim();
        if (!trimmed) {
            return '<user_input>\n请参考附加信息。\n</user_input>';
        }
        return `<user_input>\n${trimmed}\n</user_input>`;
    });

    cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

    // 3. Construct <add-info> container
    const addInfoInner = extractedItems.map(item => `${item.header}\n${item.content}`).join('\n\n');
    const addInfoBlock = `<add-info>\n${addInfoInner}\n</add-info>`;

    // 4. Assemble: <add-info> comes first, outside <user_input>
    if (cleanedText) {
        return `${addInfoBlock}\n\n${cleanedText}`;
    } else {
        return addInfoBlock;
    }
}

/**
 * Strips both <add-info>...</add-info> and raw reference tags from historical messages,
 * ensuring references are single-turn only and do NOT persist in future conversation history.
 * @param {string} text
 * @returns {string}
 */
export function stripReferencesAndAddInfo(text) {
    if (!text || typeof text !== 'string') return text;

    // 1. Remove previously injected <add-info>...</add-info> block
    let cleaned = text.replace(/<add-info>[\s\S]*?<\/add-info>\s*/g, '');

    // 2. Remove all reference tags [草稿: ...], [草稿名: ...], etc.
    const refPattern = /\[(草稿|草稿名|草稿全文|角色设定|角色设定名|角色设定全文|用户设定|用户设定名|用户设定全文|世界书条目|世界书条目名|世界书条目全文):\s*([^\]]+)\]/g;
    cleaned = cleaned.replace(refPattern, '');

    // 3. Clean up empty <user_input>
    cleaned = cleaned.replace(/<user_input>([\s\S]*?)<\/user_input>/g, (m, inner) => {
        const trimmed = inner.replace(/^\s*\n+|\n+\s*$/g, '').trim();
        return trimmed ? `<user_input>\n${trimmed}\n</user_input>` : '';
    });

    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // Fallback: prevent empty message body which triggers 400 errors in Claude/OpenAI
    if (!cleaned) {
        return '请参考上述设定。';
    }
    return cleaned;
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

            const chat = eventData.chat;
            if (chat.length === 0) return;

            // Find index of the latest user message (active current turn)
            let lastUserIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.role === 'user') {
                    lastUserIdx = i;
                    break;
                }
            }

            // A. Historical messages (strictly before lastUserIdx):
            // Single-turn injection guarantee: strip <add-info> and reference tags from all past turns
            // so referenced files/names do NOT persist in history!
            for (let i = 0; i < lastUserIdx; i++) {
                const msg = chat[i];
                if (!msg) continue;
                if (typeof msg.content === 'string') {
                    msg.content = stripReferencesAndAddInfo(msg.content);
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part && typeof part.text === 'string') {
                            part.text = stripReferencesAndAddInfo(part.text);
                        }
                    }
                }
            }

            // B. Active current turn (lastUserIdx):
            // Inject references only into the active user message
            if (lastUserIdx !== -1) {
                const msg = chat[lastUserIdx];
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

    console.log('[Worldlore Agent] Prompt reference injector (<add-info>) initialized.');
}
