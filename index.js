import { eventSource, event_types } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { MacrosParser } from '/scripts/macros.js';
import { registerAllToolsWithToolManager, getTextModeToolsPrompt } from './src/tools/index.js';
import { parseAndExecuteActions } from './src/utils/parser.js';
import { initUI, updateStagingCounter } from './src/ui/ui.js';
import { initPromptInjector } from './src/utils/injector.js';
import { initPromptSanitizer } from './src/utils/sanitizer.js';

jQuery(async () => {
    console.log('[Worldlore Agent] Initializing extension A助手...');

    // 1. Initialize UI components (Circular Floating Ball, Merged Header Drawer, Staging Inspector, History/Undo/Redo, Theme Engine)
    initUI();

    // 2. Register native function tools into SillyTavern ToolManager
    registerAllToolsWithToolManager();

    // 3. Register global macro {{worldlore_tools}} for text mode presets
    try {
        if (typeof MacrosParser !== 'undefined' && typeof MacrosParser.registerMacro === 'function') {
            MacrosParser.registerMacro('worldlore_tools', () => {
                return getTextModeToolsPrompt();
            }, 'A助手已勾选的文本模式工具列表与调用格式');
            MacrosParser.registerMacro('worldlore_agent_tools', () => {
                return getTextModeToolsPrompt();
            }, 'A助手已勾选的文本模式工具列表与调用格式');
            console.log('[Worldlore Agent] Registered global macro {{worldlore_tools}}');
        }
    } catch (e) {
        console.warn('[Worldlore Agent] Could not register macro with MacrosParser:', e);
    }

    // 4. Initialize Prompt Reference Injector (dynamically expands [草稿: xxx] into file content for LLM)
    initPromptInjector();

    // 5. Initialize Route A Prompt Context Sanitizer (dynamically strips historical tool calls before sending to API)
    initPromptSanitizer();

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
