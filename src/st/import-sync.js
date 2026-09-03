import { writeFile, deleteFile, readFile } from '../core/workspace.js';
import {
    loadWorldInfo,
    selected_world_info,
    world_names
} from '/scripts/world-info.js';
import {
    characters,
    this_chid
} from '/script.js';
import {
    getCurrentCharacter,
    getCurrentPersona,
    getCharacterBoundLorebooks
} from './st-sync.js';

/**
 * Parses simple YAML-like frontmatter from markdown
 * @param {string} text
 * @returns {{ data: object, content: string }}
 */
export function parseFrontmatter(text) {
    if (!text || typeof text !== 'string') return { data: {}, content: '' };
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { data: {}, content: text };

    const yamlBlock = match[1];
    const content = match[2];
    const data = {};

    const lines = yamlBlock.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        const valStr = line.slice(colonIdx + 1).trim();

        if (valStr.startsWith('[') && valStr.endsWith(']')) {
            try {
                data[key] = JSON.parse(valStr);
            } catch {
                data[key] = valStr.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
            }
        } else if (valStr === 'true') {
            data[key] = true;
        } else if (valStr === 'false') {
            data[key] = false;
        } else if (!isNaN(Number(valStr)) && valStr !== '') {
            data[key] = Number(valStr);
        } else {
            data[key] = valStr.replace(/^['"]|['"]$/g, '');
        }
    }

    return { data, content };
}

/**
 * Formats frontmatter string
 * @param {object} data
 * @param {string} content
 * @returns {string}
 */
export function formatFrontmatter(data, content) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) {
            lines.push(`${k}: ${JSON.stringify(v)}`);
        } else if (typeof v === 'boolean' || typeof v === 'number') {
            lines.push(`${k}: ${v}`);
        } else {
            lines.push(`${k}: "${String(v ?? '').replace(/"/g, '\\"')}"`);
        }
    }
    lines.push('---');
    lines.push('');
    lines.push(content || '');
    return lines.join('\n');
}

/**
 * Import a Lorebook from SillyTavern into the workspace using Scheme C:
 * lorebooks/<book_name>/meta.json
 * lorebooks/<book_name>/<entry_comment>.md (with YAML frontmatter)
 */
export async function importLorebookToWorkspace({ bookName, folderPath }) {
    let targetBook = bookName;
    if (!targetBook) {
        const bound = getCharacterBoundLorebooks();
        if (bound.length > 0) targetBook = bound[0];
        else throw new Error('未指定世界书名称，且当前角色未绑定任何专属世界书！');
    }

    const data = await loadWorldInfo(targetBook);
    if (!data) {
        throw new Error(`无法加载世界书: "${targetBook}"，请检查该世界书是否存在。`);
    }

    const safeBookName = String(targetBook).replace(/[/\\:*?"<>|]/g, '_').trim();
    const folder = folderPath ? String(folderPath).trim().replace(/^\/+|\/+$/g, '') : `lorebooks/${safeBookName}`;

    // 1. Meta JSON
    const meta = {
        bookName: targetBook,
        scan_depth: data.scan_depth,
        token_budget: data.token_budget,
        recursive: data.recursive,
        extensions: data.extensions || {},
        originalEntriesCount: data.entries ? Object.keys(data.entries).length : 0,
        importedAt: new Date().toISOString()
    };
    writeFile(`${folder}/meta.json`, JSON.stringify(meta, null, 2), 'overwrite');

    // 2. Entries to .md
    const generatedFiles = [`${folder}/meta.json`];
    const entries = data.entries ? Object.values(data.entries) : [];

    const usedComments = new Set();
    for (const e of entries) {
        let rawComment = (e.comment || `entry_${e.uid}`).trim();
        let safeComment = rawComment.replace(/[/\\:*?"<>|]/g, '_').trim() || `entry_${e.uid}`;

        // Ensure unique filename
        let uniqueComment = safeComment;
        let counter = 1;
        while (usedComments.has(uniqueComment.toLowerCase())) {
            uniqueComment = `${safeComment}_${counter++}`;
        }
        usedComments.add(uniqueComment.toLowerCase());

        const filePath = `${folder}/${uniqueComment}.md`;
        const frontmatter = {
            uid: e.uid,
            comment: rawComment,
            keys: Array.isArray(e.key) ? e.key : [],
            secondary_keys: Array.isArray(e.keysecondary) ? e.keysecondary : [],
            constant: !!e.constant,
            enabled: !e.disable,
            order: e.order ?? 100,
            position: e.position ?? 0,
            depth: e.depth ?? 4,
            role: e.role ?? 0,
            selectiveLogic: e.selectiveLogic ?? 0,
            probability: e.probability ?? 100
        };

        const mdContent = formatFrontmatter(frontmatter, e.content || '');
        writeFile(filePath, mdContent, 'overwrite');
        generatedFiles.push(filePath);
    }

    return {
        bookName: targetBook,
        folder,
        filesCount: generatedFiles.length,
        files: generatedFiles
    };
}

/**
 * Import Character Card into Workspace:
 * character/<charName>/description.md
 * character/<charName>/personality.md
 * character/<charName>/scenario.md
 * character/<charName>/first_mes.md
 * character/<charName>/mes_example.md
 * character/<charName>/system_prompt.md
 * character/<charName>/meta.json
 */
export async function importCharacterToWorkspace({ folderPath } = {}) {
    const char = getCurrentCharacter();
    if (!char) {
        throw new Error('当前未选中任何角色卡！');
    }

    const safeName = String(char.name || 'character').replace(/[/\\:*?"<>|]/g, '_').trim();
    const folder = folderPath ? String(folderPath).trim().replace(/^\/+|\/+$/g, '') : `character/${safeName}`;

    const fields = [
        { key: 'description', file: 'description.md' },
        { key: 'personality', file: 'personality.md' },
        { key: 'scenario', file: 'scenario.md' },
        { key: 'first_mes', file: 'first_mes.md' },
        { key: 'mes_example', file: 'mes_example.md' },
        { key: 'system_prompt', file: 'system_prompt.md' },
        { key: 'creator_notes', file: 'creator_notes.md' }
    ];

    const generatedFiles = [];
    for (const f of fields) {
        const val = char[f.key] || char.data?.[f.key] || '';
        const filePath = `${folder}/${f.file}`;
        writeFile(filePath, val, 'overwrite');
        generatedFiles.push(filePath);
    }

    // Meta JSON
    const meta = {
        name: char.name,
        avatar: char.avatar,
        creator: char.creator || char.data?.creator || '',
        character_version: char.character_version || char.data?.character_version || '',
        tags: char.tags || char.data?.tags || [],
        bound_lorebook: char.data?.extensions?.world || char.world || null,
        importedAt: new Date().toISOString()
    };
    const metaPath = `${folder}/meta.json`;
    writeFile(metaPath, JSON.stringify(meta, null, 2), 'overwrite');
    generatedFiles.push(metaPath);

    return {
        characterName: char.name,
        folder,
        filesCount: generatedFiles.length,
        files: generatedFiles
    };
}

/**
 * Import User Persona into Workspace:
 * persona/<userName>/description.md
 * persona/<userName>/meta.json
 */
export async function importPersonaToWorkspace({ folderPath } = {}) {
    const persona = getCurrentPersona();
    if (!persona) {
        throw new Error('未获取到当前用户设定！');
    }

    const safeName = String(persona.name || 'default_user').replace(/[/\\:*?"<>|]/g, '_').trim();
    const folder = folderPath ? String(folderPath).trim().replace(/^\/+|\/+$/g, '') : `persona/${safeName}`;

    const descPath = `${folder}/description.md`;
    writeFile(descPath, persona.description || '', 'overwrite');

    const meta = {
        name: persona.name,
        avatar: persona.avatar,
        depth: persona.depth ?? 0,
        position: persona.position ?? 0,
        lorebook: persona.lorebook || null,
        importedAt: new Date().toISOString()
    };
    const metaPath = `${folder}/meta.json`;
    writeFile(metaPath, JSON.stringify(meta, null, 2), 'overwrite');

    return {
        personaName: persona.name,
        folder,
        filesCount: 2,
        files: [descPath, metaPath]
    };
}