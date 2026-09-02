import { eventSource, event_types } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { registerAllToolsWithToolManager } from './src/tools.js';
import { parseAndExecuteActions } from './src/parser.js';
import { initUI, updateStagingCounter } from './src/ui.js';
import { initPromptInjector } from './src/injector.js';

jQuery(async () => {
    console.log('[Worldlore Agent] Initializing extension A助手...');

    // 1. Initialize UI components (Circular Floating Ball, Merged Header Drawer, Staging Inspector, History/Undo/Redo, Theme Engine)
    initUI();

    // 2. Register native function tools into SillyTavern ToolManager
    registerAllToolsWithToolManager();

    // 3. Initialize Prompt Reference Injector (dynamically expands [草稿: xxx] into file content for LLM)
    initPromptInjector();

    // 3. Listen to message rendering to support Dual-Mode parsing (Text/Tag fallback for DeepSeek, etc.)
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        try {
            const context = getContext();
            const message = context.chat[messageId];
            if (!message || message.is_user) return;

            const messageElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
            if (messageElement && message.mes) {
                await parseAndExecuteActions(message.mes, messageElement);
                updateStagingCounter();
            }
        } catch (e) {
            console.error('[Worldlore Agent] Error during CHARACTER_MESSAGE_RENDERED:', e);
        }
    });

    console.log('[Worldlore Agent] Extension A助手 loaded successfully.');
});
