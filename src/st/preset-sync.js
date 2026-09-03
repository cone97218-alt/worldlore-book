import { getRequestHeaders } from '/script.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { openai_settings, openai_setting_names } from '/scripts/openai.js';
import { Popup } from '/scripts/popup.js';
import { DEFAULT_PRESET_DATA } from './default-preset-data.js';

/**
 * Loads the bundled preset JSON data
 * Guaranteed zero-network, zero-404, and cross-platform compatible
 * @returns {Promise<object>}
 */
export async function loadBundledPreset() {
    if (DEFAULT_PRESET_DATA && typeof DEFAULT_PRESET_DATA === 'object') {
        return structuredClone(DEFAULT_PRESET_DATA);
    }

    // Dynamic relative URL fallback (relative to current script location)
    try {
        const dynamicUrl = new URL('../../presets/worldlore_preset.json', import.meta.url).href;
        const resp = await fetch(dynamicUrl + `?v=${Date.now()}`);
        if (resp.ok) {
            return await resp.json();
        }
    } catch (e) {
        console.warn('[Worldlore Agent] Fallback fetch failed:', e);
    }

    throw new Error('无法读取预设数据');
}

/**
 * Imports the bundled preset into SillyTavern
 * @returns {Promise<{ success: boolean, name?: string, reason?: string }>}
 */
export async function importBundledPresetToSillyTavern() {
    try {
        const presetData = await loadBundledPreset();
        if (!presetData || typeof presetData !== 'object') {
            toastr.error('预设数据为空或格式不合法！');
            return { success: false, reason: 'invalid_data' };
        }

        const presetName = String(presetData.name || 'A助手 官方预设').trim();

        // 1. Instruct Template detection
        if (presetData.input_sequence !== undefined && presetData.output_sequence !== undefined) {
            const manager = getPresetManager ? getPresetManager('instruct') : null;
            if (manager && typeof manager.savePreset === 'function') {
                await manager.savePreset(presetName, presetData);
                toastr.success(`已成功导入指令模板【${presetName}】到酒馆！`);
                return { success: true, name: presetName, type: 'instruct' };
            }
        }

        // 2. Context Template detection
        if (presetData.story_string !== undefined) {
            const manager = getPresetManager ? getPresetManager('context') : null;
            if (manager && typeof manager.savePreset === 'function') {
                await manager.savePreset(presetName, presetData);
                toastr.success(`已成功导入上下文模板【${presetName}】到酒馆！`);
                return { success: true, name: presetName, type: 'context' };
            }
        }

        // 3. System Prompt detection
        if (presetData.content !== undefined && Object.keys(presetData).length <= 3) {
            const manager = getPresetManager ? getPresetManager('sysprompt') : null;
            if (manager && typeof manager.savePreset === 'function') {
                await manager.savePreset(presetName, presetData);
                toastr.success(`已成功导入系统提示词【${presetName}】到酒馆！`);
                return { success: true, name: presetName, type: 'sysprompt' };
            }
        }

        // 4. Default & Primary: OpenAI / Chat Completion Preset
        if (typeof openai_setting_names !== 'undefined' && presetName in openai_setting_names) {
            const confirm = await Popup.show.confirm(
                '覆盖已有预设',
                `酒馆中已存在同名预设 <b>"${presetName}"</b>。<br>是否覆盖该预设？`
            );
            if (!confirm) {
                return { success: false, reason: 'cancelled' };
            }
        }

        const cleanPreset = structuredClone(presetData);
        if ('name' in cleanPreset) {
            cleanPreset.name = presetName;
        }

        const openaiManager = getPresetManager ? getPresetManager('openai') : null;
        if (openaiManager && typeof openaiManager.savePreset === 'function') {
            await openaiManager.savePreset(presetName, cleanPreset);
            if (typeof openaiManager.findPreset === 'function' && typeof openaiManager.selectPreset === 'function') {
                const opt = openaiManager.findPreset(presetName);
                if (opt) openaiManager.selectPreset(opt);
            }
        } else {
            // Fallback direct API call
            const response = await fetch('/api/presets/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    apiId: 'openai',
                    name: presetName,
                    preset: cleanPreset,
                }),
            });

            if (!response.ok) {
                throw new Error(`保存到酒馆失败: HTTP ${response.status}`);
            }

            const result = await response.json();
            const finalName = result?.name || presetName;

            if (typeof openai_settings !== 'undefined' && typeof openai_setting_names !== 'undefined') {
                if (Object.keys(openai_setting_names).includes(finalName)) {
                    const index = openai_setting_names[finalName];
                    Object.assign(openai_settings[index], cleanPreset);
                    $(`#settings_preset_openai option[value="${index}"]`).prop('selected', true);
                } else {
                    openai_settings.push(cleanPreset);
                    const newIndex = openai_settings.length - 1;
                    openai_setting_names[finalName] = newIndex;
                    const opt = document.createElement('option');
                    opt.selected = true;
                    opt.value = String(newIndex);
                    opt.innerText = finalName;
                    $('#settings_preset_openai').append(opt);
                }
                $('#settings_preset_openai').trigger('change');
            }
        }

        toastr.success(`🎉 预设【${presetName}】已成功导入并注册到酒馆！`);
        return { success: true, name: presetName, type: 'openai' };
    } catch (e) {
        console.error('[Worldlore Agent] Failed to import preset to SillyTavern:', e);
        toastr.error(`导入预设失败: ${e.message || e}`);
        return { success: false, reason: e.message || String(e) };
    }
}
