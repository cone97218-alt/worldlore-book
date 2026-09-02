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

    const refPattern = /\[(草稿|角色设定|用户设定|世界书条目):\s*([^\]]+)\]/g;
    const matches = [...text.matchAll(refPattern)];
    if (matches.length === 0) return text;

    const extractedItems = [];

    for (const match of matches) {
        const fullTag = match[0];
        const refType = match[1];
        const refArg = match[2].trim();

        if (refType === '草稿') {
            const content = readFile(refArg);
            if (content !== null && content !== undefined) {
                extractedItems.push({
                    fullTag,
                    header: `[草稿: ${refArg}]`,
                    content: `<referenced_file path="${refArg}">\n${content}\n</referenced_file>`
                });
            }
        } else if (refType === '角色设定') {
            const dotIdx = refArg.lastIndexOf('.');
            const fieldKey = dotIdx !== -1 ? refArg.substring(dotIdx + 1).trim() : refArg;
            const char = getCurrentCharacter();
            if (char && char[fieldKey] !== undefined && char[fieldKey] !== null) {
                extractedItems.push({
                    fullTag,
                    header: `[角色设定: ${refArg}]`,
                    content: `<referenced_character_field field="${fieldKey}">\n${char[fieldKey]}\n</referenced_character_field>`
                });
            }
        } else if (refType === '用户设定') {
            const dotIdx = refArg.lastIndexOf('.');
            const fieldKey = dotIdx !== -1 ? refArg.substring(dotIdx + 1).trim() : refArg;
            const persona = getCurrentPersona();
            if (persona && persona[fieldKey] !== undefined && persona[fieldKey] !== null) {
                extractedItems.push({
                    fullTag,
                    header: `[用户设定: ${refArg}]`,
                    content: `<referenced_persona_field field="${fieldKey}">\n${persona[fieldKey]}\n</referenced_persona_field>`
                });
            }
        } else if (refType === '世界书条目') {
            const parts = refArg.split('>').map(s => s.trim());
            const bookName = parts.length > 1 ? parts[0] : null;
            const commentName = parts.length > 1 ? parts[1] : parts[0];
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

    console.log('[Worldlore Agent] Prompt reference injector (<add-info>) initialized.');
}
