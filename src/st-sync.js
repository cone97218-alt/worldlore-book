import { getContext } from '/scripts/extensions.js';
import { characters, this_chid, createOrEditCharacter, saveCharacterDebounced, eventSource, event_types, chat_metadata } from '/script.js';
import { power_user } from '/scripts/power-user.js';
import { getOrCreatePersonaDescriptor, user_avatar } from '/scripts/personas.js';
import { world_names, world_info, selected_world_info, loadWorldInfo, saveWorldInfo, reloadEditor, createNewWorldInfo, charUpdatePrimaryWorld, charUpdateAddAuxWorld, setWorldInfoButtonClass } from '/scripts/world-info.js';

export function getAvailableWorldInfos() {
    return Array.isArray(world_names) ? [...world_names] : [];
}

/**
 * Returns character-bound lorebooks (Primary + Extra)
 */
export function getCharacterBoundLorebooks() {
    if (this_chid === undefined || this_chid === null || !characters[this_chid]) {
        return [];
    }
    const char = characters[this_chid];
    const bound = [];

    const primary = char.data?.extensions?.world || char.world;
    if (primary && typeof primary === 'string' && primary.trim()) {
        bound.push(primary.trim());
    }

    if (char.avatar) {
        const fileName = char.avatar.replace(/\.[^/.]+$/, '');
        const extraCharLore = world_info?.charLore?.find(e => e.name === fileName);
        if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
            for (const b of extraCharLore.extraBooks) {
                if (b && !bound.includes(b)) bound.push(b);
            }
        }
    }

    return bound;
}

/**
 * Returns chat-bound lorebook (from current chat session)
 */
export function getChatBoundLorebooks() {
    const books = [];
    if (chat_metadata && chat_metadata.world_info && world_names.includes(chat_metadata.world_info)) {
        books.push(chat_metadata.world_info);
    }
    return books;
}

/**
 * Returns global active lorebooks in ST
 */
export function getGlobalActiveLorebooks() {
    if (Array.isArray(selected_world_info)) {
        return selected_world_info.filter(b => world_names.includes(b));
    }
    if (Array.isArray(world_info?.globalSelect)) {
        return world_info.globalSelect.filter(b => world_names.includes(b));
    }
    return [];
}

/**
 * Overview of all lorebooks categorized by scope
 */
export function getLorebooksOverview() {
    const char = getCurrentCharacter();
    const characterBound = getCharacterBoundLorebooks();
    const chatBound = getChatBoundLorebooks();
    const globalActive = getGlobalActiveLorebooks();
    const allAvailable = getAvailableWorldInfos();

    return {
        characterName: char?.name || null,
        characterBoundLorebooks: characterBound,
        chatBoundLorebooks: chatBound,
        globalActiveLorebooks: globalActive,
        allAvailableLorebooksInST: allAvailable
    };
}

export async function fetchWorldInfo(bookName) {
    if (!bookName) return null;
    try {
        const data = await loadWorldInfo(bookName);
        return data;
    } catch (e) {
        console.error(`[Worldlore Agent] Failed to load world info ${bookName}:`, e);
        return null;
    }
}

/**
 * Multi-scope Lorebook reader
 */
export async function readLorebookEntriesScoped({ scope = 'character', book_name = '', query = '', max_entries = 40 } = {}) {
    let targetBooks = [];

    if (book_name && book_name.trim()) {
        const exact = book_name.trim();
        targetBooks = [exact];
    } else {
        const charBound = getCharacterBoundLorebooks();
        const chatBound = getChatBoundLorebooks();
        const globalActive = getGlobalActiveLorebooks();

        switch (scope) {
            case 'chat':
                targetBooks = chatBound;
                if (targetBooks.length === 0) {
                    return { error: '当前聊天未绑定专属世界书。', overview: getLorebooksOverview() };
                }
                break;
            case 'global':
                targetBooks = globalActive;
                if (targetBooks.length === 0) {
                    return { error: '酒馆当前未启用任何全局世界书。', overview: getLorebooksOverview() };
                }
                break;
            case 'active':
                targetBooks = Array.from(new Set([...charBound, ...chatBound, ...globalActive]));
                if (targetBooks.length === 0) {
                    return { error: '当前没有处于激活状态的世界书（角色/聊天/全局均未绑定）。', overview: getLorebooksOverview() };
                }
                break;
            case 'all':
                targetBooks = getAvailableWorldInfos();
                break;
            case 'character':
            default:
                targetBooks = charBound;
                if (targetBooks.length === 0) {
                    const char = getCurrentCharacter();
                    return {
                        error: `当前角色 [${char?.name || '未知'}] 未绑定专属世界书。你可以指定 book_name 读取其它世界书，或在角色卡设置中进行绑定。`,
                        overview: getLorebooksOverview()
                    };
                }
                break;
        }
    }

    const allEntries = [];

    for (const book of targetBooks) {
        const data = await loadWorldInfo(book);
        if (!data || !data.entries) continue;

        let list = Object.values(data.entries);
        if (query) {
            const lower = query.toLowerCase();
            list = list.filter(e => 
                (e.comment && e.comment.toLowerCase().includes(lower)) ||
                (e.content && e.content.toLowerCase().includes(lower)) ||
                (Array.isArray(e.key) && e.key.some(k => String(k).toLowerCase().includes(lower)))
            );
        }

        for (const e of list) {
            allEntries.push({
                book,
                uid: e.uid,
                comment: e.comment || '',
                keys: e.key || [],
                secondary_keys: e.keysecondary || [],
                content: e.content || '',
                constant: !!e.constant,
                enabled: !e.disable,
                disable: !!e.disable,
                order: e.order ?? 100,
                position: e.position ?? 0,
                depth: e.depth ?? 4,
                role: e.role ?? 0,
                selectiveLogic: e.selectiveLogic ?? 0,
                probability: e.probability ?? 100,
                sticky: e.sticky ?? 0,
                cooldown: e.cooldown ?? 0,
            });
        }
    }

    return {
        queryScope: book_name ? `explicit: ${book_name}` : scope,
        searchedBooks: targetBooks,
        matchedCount: allEntries.length,
        returnedCount: Math.min(allEntries.length, max_entries),
        entries: allEntries.slice(0, max_entries)
    };
}

export async function applyWorldInfoEntry(bookName, entry) {
    let targetBook = bookName;
    if (!targetBook) {
        const bound = getCharacterBoundLorebooks();
        if (bound.length > 0) targetBook = bound[0];
        else {
            const available = getAvailableWorldInfos();
            targetBook = available.length > 0 ? available[0] : 'default';
        }
    }

    let data = await loadWorldInfo(targetBook);
    if (!data) data = { entries: {} };
    if (!data.entries) data.entries = {};

    let action = entry.action || (entry.uid !== undefined ? 'update' : 'add');
    const entriesArray = Object.values(data.entries);

    if (action === 'delete') {
        let targetUid = entry.uid;
        if (targetUid === undefined && entry.comment) {
            const found = entriesArray.find(e => e.comment && e.comment.trim().toLowerCase() === entry.comment.trim().toLowerCase());
            if (found) targetUid = found.uid;
        }
        if (targetUid !== undefined && data.entries[targetUid]) {
            const prevData = { ...data.entries[targetUid] };
            delete data.entries[targetUid];
            await saveWorldInfo(targetBook, data);
            reloadEditor();
            return { success: true, action: 'delete', uid: targetUid, book: targetBook, beforeState: prevData };
        }
        throw new Error(`Entry to delete not found: ${entry.comment || entry.uid}`);
    }

    if (action === 'update' || action === 'add') {
        let targetUid = entry.uid;
        let existing = null;

        if (targetUid !== undefined && data.entries[targetUid]) {
            existing = data.entries[targetUid];
        } else if (entry.comment) {
            existing = entriesArray.find(e => e.comment && e.comment.trim().toLowerCase() === entry.comment.trim().toLowerCase());
            if (existing) targetUid = existing.uid;
        }

        const beforeState = existing ? JSON.parse(JSON.stringify(existing)) : null;

        if (action === 'update' && !existing) {
            action = 'add';
        }

        if (action === 'add' || targetUid === undefined || !existing) {
            const uids = Object.keys(data.entries).map(Number).filter(n => !isNaN(n));
            targetUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
            existing = {
                uid: targetUid,
                key: [],
                keysecondary: [],
                comment: '',
                content: '',
                constant: false,
                selective: true,
                selectiveLogic: 0,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: true,
                depth: 4,
                group: '',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: null,
                matchWholeWords: null,
                useGroupScoring: null,
                automationId: '',
                role: 0,
                vectorized: false,
                sticky: 0,
                cooldown: 0,
                delay: 0,
                displayIndex: targetUid,
            };
        }

        if (entry.comment !== undefined) existing.comment = String(entry.comment);
        if (entry.content !== undefined) existing.content = String(entry.content);
        if (entry.keys !== undefined) {
            existing.key = Array.isArray(entry.keys) ? entry.keys : String(entry.keys).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (entry.secondary_keys !== undefined) {
            existing.keysecondary = Array.isArray(entry.secondary_keys) ? entry.secondary_keys : String(entry.secondary_keys).split(',').map(s => s.trim()).filter(Boolean);
        }
        
        if (entry.constant !== undefined) existing.constant = Boolean(entry.constant);

        if (entry.enabled !== undefined) {
            existing.disable = !entry.enabled;
        } else if (entry.disable !== undefined) {
            existing.disable = Boolean(entry.disable);
        }

        if (entry.order !== undefined) existing.order = Number(entry.order);
        if (entry.position !== undefined) existing.position = Number(entry.position);
        if (entry.depth !== undefined) existing.depth = Number(entry.depth);
        if (entry.role !== undefined) existing.role = Number(entry.role);

        if (entry.selective_logic !== undefined) existing.selectiveLogic = Number(entry.selective_logic);
        if (entry.logic !== undefined) existing.selectiveLogic = Number(entry.logic);
        if (entry.probability !== undefined) {
            existing.probability = Number(entry.probability);
            existing.useProbability = true;
        }
        if (entry.sticky !== undefined) existing.sticky = Number(entry.sticky);
        if (entry.cooldown !== undefined) existing.cooldown = Number(entry.cooldown);

        data.entries[targetUid] = existing;
        await saveWorldInfo(targetBook, data);
        reloadEditor();
        return {
            success: true,
            action: beforeState ? 'update' : 'add',
            uid: targetUid,
            book: targetBook,
            beforeState: beforeState,
            afterState: JSON.parse(JSON.stringify(existing)),
            entry: existing
        };
    }

    throw new Error(`Unknown action: ${action}`);
}

/**
 * Creates a new world info book and binds it to the current character card
 * @param {Object} options
 * @param {string} [options.bookName] - Name of the new world info. If empty, defaults to `${char.name}_世界书`.
 * @param {boolean} [options.bind=true] - Whether to bind to current character.
 * @param {'primary'|'additional'} [options.bindType='primary'] - 'primary' or 'additional'.
 * @param {Array} [options.initialEntries=[]] - Initial world info entries to inject.
 */
export async function createAndBindWorldInfo({
    bookName = '',
    bind = true,
    bindType = 'primary',
    initialEntries = []
} = {}) {
    const char = getCurrentCharacter();
    let finalBookName = String(bookName || '').trim();

    if (!finalBookName) {
        if (char && char.name) {
            finalBookName = `${char.name}_世界书`;
        } else {
            finalBookName = `世界书_${Date.now().toString(36)}`;
        }
    }

    // Clean up filename: remove characters forbidden in filenames
    finalBookName = finalBookName.replace(/[/\\:*?"<>|]/g, '_').trim();

    // If already exists, generate a non-colliding name
    let counter = 1;
    let baseName = finalBookName;
    while (Array.isArray(world_names) && world_names.includes(finalBookName)) {
        counter++;
        finalBookName = `${baseName}_${counter}`;
    }

    let created = false;
    try {
        created = await createNewWorldInfo(finalBookName, { interactive: false });
    } catch (e) {
        console.warn('[Worldlore Agent] createNewWorldInfo threw error, attempting fallback:', e);
    }

    if (!created) {
        await saveWorldInfo(finalBookName, { entries: {} }, true);
        if (Array.isArray(world_names) && !world_names.includes(finalBookName)) {
            world_names.push(finalBookName);
        }
    }

    // If initialEntries provided, populate them
    const addedEntries = [];
    if (Array.isArray(initialEntries) && initialEntries.length > 0) {
        for (const entry of initialEntries) {
            try {
                const res = await applyWorldInfoEntry(finalBookName, entry);
                addedEntries.push(res);
            } catch (err) {
                console.warn('[Worldlore Agent] Failed to add initial entry:', err);
            }
        }
    }

    let boundSuccess = false;
    let previousPrimary = null;
    let previousBound = [];

    if (bind) {
        if (this_chid === undefined || this_chid === null || !characters[this_chid]) {
            console.warn('[Worldlore Agent] No character currently selected, cannot bind worldbook');
        } else {
            const rawChar = characters[this_chid];
            previousPrimary = rawChar.data?.extensions?.world || rawChar.world || null;
            previousBound = getCharacterBoundLorebooks();

            if (bindType === 'additional' || bindType === 'extra') {
                await charUpdateAddAuxWorld(rawChar.avatar, finalBookName);
                boundSuccess = true;
            } else {
                // Primary bind
                $('#form_create').attr('actiontype', 'editcharacter');
                $('#character_world').val(finalBookName);
                if (!rawChar.data) rawChar.data = {};
                if (!rawChar.data.extensions) rawChar.data.extensions = {};
                rawChar.data.extensions.world = finalBookName;
                rawChar.world = finalBookName;

                await charUpdatePrimaryWorld(finalBookName);
                saveCharacterDebounced();
                boundSuccess = true;
            }

            setWorldInfoButtonClass(this_chid);
            eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: this_chid, character: rawChar } });
        }
    }

    reloadEditor();
    eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);

    return {
        success: true,
        bookName: finalBookName,
        bound: boundSuccess,
        bindType: bind ? bindType : 'none',
        characterName: char?.name || null,
        previousPrimary,
        previousBound,
        addedEntriesCount: addedEntries.length
    };
}

/**
 * Restores previous character lorebook binding (for undo)
 */
export async function restoreCharacterLorebookBinding({ previousPrimary = null, addedAuxBook = null } = {}) {
    if (this_chid === undefined || this_chid === null || !characters[this_chid]) return;
    const rawChar = characters[this_chid];

    if (previousPrimary !== undefined) {
        $('#form_create').attr('actiontype', 'editcharacter');
        $('#character_world').val(previousPrimary || '');
        if (!rawChar.data) rawChar.data = {};
        if (!rawChar.data.extensions) rawChar.data.extensions = {};
        rawChar.data.extensions.world = previousPrimary || '';
        rawChar.world = previousPrimary || '';

        await charUpdatePrimaryWorld(previousPrimary || '');
        saveCharacterDebounced();
    }

    if (addedAuxBook && rawChar.avatar) {
        const fileName = rawChar.avatar.replace(/\.[^/.]+$/, '');
        const charLore = world_info?.charLore;
        const entry = charLore?.find(e => e.name === fileName);
        if (entry && Array.isArray(entry.extraBooks)) {
            entry.extraBooks = entry.extraBooks.filter(b => b !== addedAuxBook);
            getContext().saveSettingsDebounced();
        }
    }

    setWorldInfoButtonClass(this_chid);
    eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: this_chid, character: rawChar } });
}


export function getCurrentCharacter() {
    if (this_chid === undefined || this_chid === null || !characters[this_chid]) {
        return null;
    }
    const char = characters[this_chid];
    const data = char.data || {};
    return {
        id: this_chid,
        name: char.name || data.name || '',
        avatar: char.avatar || '',
        description: data.description || char.description || '',
        personality: data.personality || char.personality || '',
        scenario: data.scenario || char.scenario || '',
        first_mes: data.first_mes || char.first_mes || '',
        mes_example: data.mes_example || char.mes_example || '',
        creator_notes: data.creator_notes || char.creator_notes || '',
        system_prompt: data.system_prompt || char.system_prompt || '',
        post_history_instructions: data.post_history_instructions || char.post_history_instructions || '',
        world: data.extensions?.world || char.world || '',
        boundLorebooks: getCharacterBoundLorebooks()
    };
}

const FIELD_DOM_SELECTORS = {
    description: '#description_textarea',
    personality: '#personality_textarea',
    scenario: '#scenario_pole',
    first_mes: '#firstmessage_textarea',
    mes_example: '#mes_example_textarea',
    creator_notes: '#creator_notes_textarea',
    system_prompt: '#system_prompt_textarea',
    post_history_instructions: '#post_history_instructions_textarea',
};

export async function applyCharacterFieldUpdate(updates) {
    if (this_chid === undefined || this_chid === null || !characters[this_chid]) {
        throw new Error('No character is currently selected in SillyTavern');
    }
    const char = characters[this_chid];
    if (!char.data) char.data = {};

    const mode = updates.mode || 'replace';
    const updatedFields = [];
    const beforeState = {};
    const afterState = {};

    $('#form_create').attr('actiontype', 'editcharacter');

    for (const [field, selector] of Object.entries(FIELD_DOM_SELECTORS)) {
        if (updates[field] !== undefined) {
            const prev = char.data[field] || char[field] || '';
            beforeState[field] = prev;

            const newContent = String(updates[field]);
            let finalValue = newContent;
            if (mode === 'append') {
                finalValue = prev ? `${prev}\n\n${newContent}` : newContent;
            }

            char.data[field] = finalValue;
            char[field] = finalValue;
            afterState[field] = finalValue;

            const inputEl = document.querySelector(selector);
            if (inputEl) {
                inputEl.value = finalValue;
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            updatedFields.push(field);
        }
    }

    if (updatedFields.length > 0) {
        await createOrEditCharacter();
        saveCharacterDebounced();
        eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: this_chid, character: char } });
    }

    return { success: true, updatedFields, beforeState, afterState, characterName: char.name || 'Character' };
}

export function getCurrentPersona() {
    const desc = getOrCreatePersonaDescriptor();
    const personaName = power_user.personas[user_avatar] || 'User';
    return {
        avatar: user_avatar,
        name: personaName,
        description: desc?.description || power_user.persona_description || '',
        depth: desc?.depth ?? power_user.persona_description_depth ?? 2,
        position: desc?.position ?? power_user.persona_description_position ?? 0,
        lorebook: desc?.lorebook || power_user.persona_description_lorebook || '',
    };
}

export function applyPersonaFieldUpdate(updates) {
    const desc = getOrCreatePersonaDescriptor();
    const mode = updates.mode || 'replace';
    const beforeState = {
        description: desc.description || power_user.persona_description || '',
        depth: desc.depth ?? power_user.persona_description_depth ?? 2,
        position: desc.position ?? power_user.persona_description_position ?? 0,
        lorebook: desc.lorebook || power_user.persona_description_lorebook || ''
    };

    if (updates.description !== undefined) {
        const newDesc = String(updates.description);
        if (mode === 'append') {
            const prev = desc.description || power_user.persona_description || '';
            desc.description = prev ? `${prev}\n\n${newDesc}` : newDesc;
        } else {
            desc.description = newDesc;
        }
        power_user.persona_description = desc.description;
        const personaEl = document.querySelector('#persona_description');
        if (personaEl) {
            personaEl.value = desc.description;
            personaEl.dispatchEvent(new Event('input', { bubbles: true }));
            personaEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if (updates.depth !== undefined) {
        desc.depth = Number(updates.depth);
        power_user.persona_description_depth = desc.depth;
        const depthEl = document.querySelector('#persona_depth_value');
        if (depthEl) depthEl.value = desc.depth;
    }

    if (updates.position !== undefined) {
        desc.position = Number(updates.position);
        power_user.persona_description_position = desc.position;
        const posEl = document.querySelector('#persona_description_position');
        if (posEl) posEl.value = desc.position;
    }

    if (updates.lorebook !== undefined) {
        desc.lorebook = String(updates.lorebook);
        power_user.persona_description_lorebook = desc.lorebook;
    }

    getContext().saveSettingsDebounced();
    return { success: true, persona: getCurrentPersona(), beforeState, afterState: getCurrentPersona() };
}
