import { characters, this_chid, saveSettings, getRequestHeaders } from '/script.js';
import { uuidv4 } from '/scripts/utils.js';
import { extension_settings } from '/scripts/extensions.js';
import {
    SCRIPT_TYPES,
    getScriptsByType,
    saveScriptsByType,
    allowScopedScripts,
    allowPresetScripts,
    getCurrentPresetAPI,
    getCurrentPresetName,
    runRegexScript,
    RegexProvider
} from '/scripts/extensions/regex/engine.js';

// Mutex queue to prevent race conditions during concurrent tool calls (e.g. 5 deletions at once)
let regexOperationMutex = Promise.resolve();
function runWithRegexMutex(fn) {
    const next = regexOperationMutex.then(fn, fn);
    regexOperationMutex = next;
    return next;
}

/**
 * Forcefully flushes settings to backend disk regardless of debouncing or TempResponseLength overrides
 */
async function forceSaveGlobalRegexToDisk() {
    try {
        if (typeof saveSettings === 'function') {
            await saveSettings();
        }
    } catch (_) {}

    // Direct atomic write to backend /api/settings/save as guaranteed fallback
    try {
        const headers = typeof getRequestHeaders === 'function' ? getRequestHeaders() : { 'Content-Type': 'application/json' };
        const getRes = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (getRes.ok) {
            const data = await getRes.json();
            const currentSettings = typeof data.settings === 'string' ? JSON.parse(data.settings) : (data.settings || data);
            if (currentSettings) {
                currentSettings.extension_settings = extension_settings;
                await fetch('/api/settings/save', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(currentSettings),
                    cache: 'no-cache',
                });
                console.log('[Worldlore Agent] Global regex successfully written to disk settings.json.');
            }
        }
    } catch (e) {
        console.warn('[Worldlore Agent] Direct disk write exception:', e);
    }
}

/**
 * Normalizes scope input ('character'|'scoped', 'global', 'preset') to SCRIPT_TYPES enum
 * @param {string|number} scope
 * @returns {number} SCRIPT_TYPES (GLOBAL: 0, SCOPED: 1, PRESET: 2)
 */
export function normalizeScope(scope) {
    if (typeof scope === 'number' && Object.values(SCRIPT_TYPES).includes(scope)) {
        return scope;
    }
    const s = String(scope || 'character').trim().toLowerCase();
    if (s === 'global') return SCRIPT_TYPES.GLOBAL;
    if (s === 'preset') return SCRIPT_TYPES.PRESET;
    if (s === 'character' || s === 'scoped') return SCRIPT_TYPES.SCOPED;
    return SCRIPT_TYPES.SCOPED;
}

/**
 * Returns human-readable scope string ('character', 'global', 'preset')
 * @param {number} scriptType
 * @returns {string}
 */
export function scopeToString(scriptType) {
    if (scriptType === SCRIPT_TYPES.GLOBAL) return 'global';
    if (scriptType === SCRIPT_TYPES.PRESET) return 'preset';
    return 'character';
}

/**
 * Reads all regex scripts for a given scope, or across all scopes
 * @param {string|number} scope 'character' | 'global' | 'preset' | 'all'
 * @returns {Array<object>}
 */
export function getRegexScripts(scope = 'character') {
    if (scope === 'all') {
        const globalList = (getScriptsByType(SCRIPT_TYPES.GLOBAL) || []).map(s => ({ ...s, _scope: 'global' }));
        const scopedList = (getScriptsByType(SCRIPT_TYPES.SCOPED) || []).map(s => ({ ...s, _scope: 'character' }));
        const presetList = (getScriptsByType(SCRIPT_TYPES.PRESET) || []).map(s => ({ ...s, _scope: 'preset' }));
        return [...scopedList, ...globalList, ...presetList];
    }
    const type = normalizeScope(scope);
    return getScriptsByType(type) || [];
}

/**
 * Finds a regex script by its name within a scope
 * @param {string|number} scope
 * @param {string} scriptName
 * @returns {{ script: object, index: number, scope: string, scriptType: number } | null}
 */
export function findRegexScript(scope, scriptName) {
    if (!scriptName) return null;
    const targetName = String(scriptName).trim().toLowerCase();

    // If scope is 'all', search across all scopes in priority order: character -> preset -> global
    if (scope === 'all') {
        const scopesToSearch = ['character', 'preset', 'global'];
        for (const s of scopesToSearch) {
            const found = findRegexScript(s, scriptName);
            if (found) return found;
        }
        return null;
    }

    const type = normalizeScope(scope);
    const list = getScriptsByType(type) || [];
    const index = list.findIndex(s => s.scriptName && s.scriptName.trim().toLowerCase() === targetName);

    if (index === -1) return null;
    return {
        script: list[index],
        index,
        scope: scopeToString(type),
        scriptType: type
    };
}

/**
 * Applies (creates or updates) a regex script into SillyTavern
 * @param {string|number} scope 'character' | 'global' | 'preset'
 * @param {object} scriptData
 * @param {boolean} [replaceExisting=true]
 * @returns {Promise<{ success: boolean, script: object, action: 'add'|'update', scope: string, beforeState: object|null }>}
 */
async function _applyRegexScriptInternal(scope, scriptData, replaceExisting = true) {
    if (!scriptData || !scriptData.scriptName) {
        throw new Error('Regex script must contain a valid scriptName');
    }

    const type = normalizeScope(scope);

    // Validate scope prerequisite
    if (type === SCRIPT_TYPES.SCOPED) {
        if (this_chid === undefined || this_chid === null || !characters[this_chid]) {
            throw new Error('当前未选中任何角色卡，无法将正则保存为角色专属！请先在酒馆选择一个角色卡。');
        }
    }

    const list = [...(getScriptsByType(type) || [])];
    const scriptNameLower = scriptData.scriptName.trim().toLowerCase();
    const existingIndex = list.findIndex(s => s.scriptName && s.scriptName.trim().toLowerCase() === scriptNameLower);

    let beforeState = null;
    let action = 'add';

    const completeScript = {
        id: scriptData.id || uuidv4(),
        scriptName: String(scriptData.scriptName).trim(),
        findRegex: scriptData.findRegex !== undefined ? String(scriptData.findRegex) : '',
        replaceString: scriptData.replaceString !== undefined ? String(scriptData.replaceString) : '',
        trimStrings: Array.isArray(scriptData.trimStrings) ? scriptData.trimStrings : [],
        placement: Array.isArray(scriptData.placement) && scriptData.placement.length > 0 ? scriptData.placement : [1, 2],
        disabled: scriptData.disabled === true,
        markdownOnly: scriptData.markdownOnly === true,
        promptOnly: scriptData.promptOnly === true,
        runOnEdit: scriptData.runOnEdit === true,
        substituteRegex: Number(scriptData.substituteRegex ?? 0),
        minDepth: scriptData.minDepth !== undefined && scriptData.minDepth !== null ? Number(scriptData.minDepth) : null,
        maxDepth: scriptData.maxDepth !== undefined && scriptData.maxDepth !== null ? Number(scriptData.maxDepth) : null,
    };

    if (existingIndex !== -1 && replaceExisting) {
        action = 'update';
        beforeState = JSON.parse(JSON.stringify(list[existingIndex]));
        completeScript.id = beforeState.id || completeScript.id; // preserve original id
        list[existingIndex] = completeScript;
    } else {
        list.push(completeScript);
    }

    // Save to ST
    await saveScriptsByType(list, type);

    if (type === SCRIPT_TYPES.GLOBAL) {
        extension_settings.regex = list;
        await forceSaveGlobalRegexToDisk();
    }

    try {
        if (RegexProvider && RegexProvider.instance && typeof RegexProvider.instance.clear === 'function') {
            RegexProvider.instance.clear();
        }
    } catch (_) {}

    // Auto-allow scoped/preset execution if applicable
    try {
        if (type === SCRIPT_TYPES.SCOPED && characters[this_chid]) {
            allowScopedScripts(characters[this_chid]);
        } else if (type === SCRIPT_TYPES.PRESET) {
            const api = getCurrentPresetAPI?.();
            const presetName = getCurrentPresetName?.();
            if (api && presetName) {
                allowPresetScripts(api, presetName);
            }
        }
    } catch (err) {
        console.warn('[Worldlore Agent] Error auto-allowing regex execution:', err);
    }

    return {
        success: true,
        script: completeScript,
        action,
        scope: scopeToString(type),
        beforeState
    };
}

/**
 * Applies regex script with mutex protection against race conditions
 */
export async function applyRegexScript(scope, scriptData, replaceExisting = true) {
    return runWithRegexMutex(() => _applyRegexScriptInternal(scope, scriptData, replaceExisting));
}

/**
 * Deletes a regex script from SillyTavern by name (thread-safe with Mutex)
 * @param {string|number} scope 'character' | 'global' | 'preset'
 * @param {string} scriptName
 * @returns {Promise<{ success: boolean, scriptName: string, scope: string, beforeState: object }>}
 */
export async function deleteRegexScript(scope, scriptName) {
    return runWithRegexMutex(async () => {
        if (!scriptName) throw new Error('Must provide scriptName to delete');

        const type = normalizeScope(scope);
        const scriptNameLower = String(scriptName).trim().toLowerCase();

        // 1. Retrieve the target script list
        let rawList = getScriptsByType(type);
        if (!Array.isArray(rawList)) {
            rawList = [];
        }

        const index = rawList.findIndex(s => s.scriptName && s.scriptName.trim().toLowerCase() === scriptNameLower);
        if (index === -1) {
            throw new Error(`在 [${scopeToString(type)}] 范围内未找到名为 "${scriptName}" 的正则脚本！`);
        }

        const beforeState = JSON.parse(JSON.stringify(rawList[index]));
        const deletedId = beforeState.id;

        // 2. In-place deletion to maintain array reference consistency
        rawList.splice(index, 1);

        // 3. Save via standard engine function
        await saveScriptsByType(rawList, type);

        // 4. For global regex, guarantee immediate disk write & clean up preset references
        if (type === SCRIPT_TYPES.GLOBAL) {
            extension_settings.regex = rawList;

            if (Array.isArray(extension_settings.regex_presets)) {
                for (const preset of extension_settings.regex_presets) {
                    if (Array.isArray(preset.global)) {
                        preset.global = preset.global.filter(item => (typeof item === 'string' ? item : item?.id) !== deletedId);
                    }
                }
            }

            // Immediately flush to disk via direct API fallback
            await forceSaveGlobalRegexToDisk();
        }

        // 5. Clear RegexProvider cache so deleted regex stops matching immediately
        try {
            if (RegexProvider && RegexProvider.instance && typeof RegexProvider.instance.clear === 'function') {
                RegexProvider.instance.clear();
            }
        } catch (_) {}

        // 6. Instantly remove card element from SillyTavern native DOM to prevent UI staleness or re-save overwrite
        try {
            if (typeof $ !== 'undefined') {
                if (deletedId) {
                    $(`#saved_regex_scripts #${deletedId}, #${deletedId}`).remove();
                }
                $('#saved_regex_scripts .regex-script-label').filter((_, el) => {
                    const name = $(el).find('.regex_script_name').text().trim().toLowerCase();
                    return name === scriptNameLower;
                }).remove();

                if ($('#saved_regex_scripts').children().length === 0) {
                    $('#saved_regex_scripts').attr('has-scripts', 'false');
                }
            }
        } catch (domErr) {
            console.warn('[Worldlore Agent] Error removing regex DOM node:', domErr);
        }

        return {
            success: true,
            scriptName: beforeState.scriptName,
            scope: scopeToString(type),
            beforeState
        };
    });
}

/**
 * Returns an overview of regex scripts across all scopes
 */
export function getRegexOverview() {
    const char = (this_chid !== undefined && this_chid !== null) ? characters[this_chid] : null;
    const charScripts = getScriptsByType(SCRIPT_TYPES.SCOPED) || [];
    const globalScripts = getScriptsByType(SCRIPT_TYPES.GLOBAL) || [];
    const presetScripts = getScriptsByType(SCRIPT_TYPES.PRESET) || [];

    return {
        character: {
            name: char?.name || null,
            count: charScripts.length,
            scripts: charScripts.map(s => ({
                id: s.id,
                name: s.scriptName,
                findRegex: s.findRegex,
                disabled: !!s.disabled,
                placement: s.placement
            }))
        },
        global: {
            count: globalScripts.length,
            scripts: globalScripts.map(s => ({
                id: s.id,
                name: s.scriptName,
                findRegex: s.findRegex,
                disabled: !!s.disabled,
                placement: s.placement
            }))
        },
        preset: {
            name: getCurrentPresetName?.() || null,
            count: presetScripts.length,
            scripts: presetScripts.map(s => ({
                id: s.id,
                name: s.scriptName,
                findRegex: s.findRegex,
                disabled: !!s.disabled,
                placement: s.placement
            }))
        }
    };
}

/**
 * Runs a regex script test against raw input text
 * @param {object} params
 * @param {object} [params.script] - Existing or custom regex script object
 * @param {string} [params.findRegex] - Regex pattern if no script provided
 * @param {string} [params.replaceString] - Replace text if no script provided
 * @param {string} params.testText - Input string to test
 * @returns {{ matched: boolean, original: string, result: string, diffLength: number }}
 */
export function testRegexExecution({ script, findRegex, replaceString, testText }) {
    if (!testText || typeof testText !== 'string') {
        throw new Error('Must provide testText string to test regex');
    }

    const targetScript = script || {
        id: 'test_script',
        scriptName: 'Test Script',
        findRegex: findRegex || '',
        replaceString: replaceString || '',
        disabled: false,
        placement: [1, 2],
        substituteRegex: 0,
        trimStrings: []
    };

    if (!targetScript.findRegex) {
        throw new Error('Regex script has no findRegex pattern configured');
    }

    const output = runRegexScript(targetScript, testText);
    const matched = output !== testText;

    return {
        matched,
        original: testText,
        result: output,
        diffLength: output.length - testText.length
    };
}
