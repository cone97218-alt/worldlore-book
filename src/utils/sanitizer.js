import { eventSource, event_types } from '/script.js';
import { getSettings } from '../core/workspace.js';

/**
 * Prompt Context Sanitizer (Route A)
 * 
 * Intercepts CHAT_COMPLETION_PROMPT_READY right before the prompt payload is sent to the LLM API.
 * Dynamically sanitizes HISTORICAL tool calls (both assistant.tool_calls and role: "tool" responses)
 * from past completed conversation turns, while strictly preserving active tool calls in the current turn.
 */
export function initPromptSanitizer() {
    console.log('[Worldlore Agent] Initializing Prompt Context Sanitizer (Route A)...');

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        try {
            if (!eventData || !Array.isArray(eventData.chat)) return;
            const settings = getSettings();

            // Default enabled. Can be toggled in settings.sanitizeHistoricalTools
            if (settings.sanitizeHistoricalTools === false) return;

            const chat = eventData.chat;
            if (chat.length === 0) return;

            // 1. Find the index of the last user message
            let lastUserIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.role === 'user') {
                    lastUserIdx = i;
                    break;
                }
            }

            // If there is no user message, nothing to sanitize
            if (lastUserIdx <= 0) return;

            let removedCount = 0;

            // 2. Iterate backwards through messages strictly BEFORE the last user message
            // Any tool calls before the last user message are historical and completed.
            for (let i = lastUserIdx - 1; i >= 0; i--) {
                const msg = chat[i];
                if (!msg) continue;

                // Case A: role === 'tool' (historical tool return payload)
                if (msg.role === 'tool') {
                    chat.splice(i, 1);
                    lastUserIdx--; // adjust index since array shifted
                    removedCount++;
                    continue;
                }

                // Case B: assistant message with tool_calls
                if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    delete msg.tool_calls;
                    delete msg.tool_call_id;
                    delete msg.signature;

                    const hasContent = typeof msg.content === 'string' && msg.content.trim().length > 0;
                    const isOnlyToolDetails = hasContent && (
                        msg.content.includes('<details') && msg.content.includes('Tool calls:')
                    );

                    if (!hasContent || isOnlyToolDetails) {
                        chat.splice(i, 1);
                        lastUserIdx--;
                        removedCount++;
                    }
                    continue;
                }

                // Case C: System message that is purely a Tool calls log
                if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('Tool calls:')) {
                    chat.splice(i, 1);
                    lastUserIdx--;
                    removedCount++;
                    continue;
                }
            }

            // 3. Merge adjacent assistant messages in historical turns if any (for Claude / strict alternating APIs)
            for (let i = lastUserIdx - 1; i > 0; i--) {
                if (chat[i]?.role === 'assistant' && chat[i - 1]?.role === 'assistant') {
                    const prevContent = chat[i - 1].content || '';
                    const curContent = chat[i].content || '';
                    chat[i - 1].content = [prevContent, curContent].filter(Boolean).join('\n\n');
                    chat.splice(i, 1);
                    lastUserIdx--;
                    removedCount++;
                }
            }

            if (removedCount > 0) {
                console.log(`[Worldlore Agent] Route A Sanitizer: Cleaned ${removedCount} historical tool artifacts from prompt context.`);
            }
        } catch (e) {
            console.error('[Worldlore Agent] Error during prompt sanitization:', e);
        }
    });
}
