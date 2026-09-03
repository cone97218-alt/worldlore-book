import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

export const EXTENSION_NAME = 'worldlore_agent';

export function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {
            enabled: true,
            toolMode: 'native',
            activeProject: 'default',
            projects: {
                'default': {
                    name: 'default',
                    description: '默认写卡工作区',
                    files: {
                        'world/overview.md': {
                            content: '# 世界总览\n在这里记录核心世界观大纲与设定草稿。\n',
                            updatedAt: Date.now()
                        }
                    },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
            },
            staging: {
                entries: [],
            },
            history: [],
            ui: {
                drawerOpen: false,
                activeTab: 'workspace',
                ballTop: 240,
                ballSide: 'right',
                theme: 'default',
                workspacePanelOpen: false,
                swipeToClose: true,
            },
        };
    }
    if (extension_settings[EXTENSION_NAME].enabled === undefined) {
        extension_settings[EXTENSION_NAME].enabled = true;
    }
    if (!extension_settings[EXTENSION_NAME].toolMode) {
        extension_settings[EXTENSION_NAME].toolMode = 'native';
    }
    if (extension_settings[EXTENSION_NAME].ui && extension_settings[EXTENSION_NAME].ui.swipeToClose === undefined) {
        extension_settings[EXTENSION_NAME].ui.swipeToClose = true;
    }
    if (!extension_settings[EXTENSION_NAME].ui) {
        extension_settings[EXTENSION_NAME].ui = {
            drawerOpen: false,
            activeTab: 'workspace',
            ballTop: 240,
            ballSide: 'right',
            theme: 'default',
            workspacePanelOpen: false,
        };
    }
    if (!Array.isArray(extension_settings[EXTENSION_NAME].history)) {
        extension_settings[EXTENSION_NAME].history = [];
    }
    return extension_settings[EXTENSION_NAME];
}

export function saveWorkspace() {
    saveSettingsDebounced();
}

export function getProjects() {
    const settings = getSettings();
    return Object.keys(settings.projects || {});
}

export function getActiveProjectName() {
    const settings = getSettings();
    return settings.activeProject || 'default';
}

export function getActiveProject() {
    const settings = getSettings();
    const active = settings.activeProject || 'default';
    if (!settings.projects[active]) {
        settings.projects[active] = {
            name: active,
            description: '',
            files: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }
    return settings.projects[active];
}

export function switchProject(name) {
    const settings = getSettings();
    if (settings.projects[name]) {
        settings.activeProject = name;
        saveWorkspace();
        return true;
    }
    return false;
}

export function createProject(name, description = '') {
    const settings = getSettings();
    if (!name || settings.projects[name]) {
        return false;
    }
    settings.projects[name] = {
        name,
        description,
        files: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    settings.activeProject = name;
    saveWorkspace();
    return true;
}

export function deleteProject(name) {
    const settings = getSettings();
    if (name === 'default') {
        settings.projects['default'] = {
            name: 'default',
            description: '默认写卡工作区',
            files: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        settings.activeProject = 'default';
        saveWorkspace();
        return true;
    }
    if (settings.projects[name]) {
        delete settings.projects[name];
        if (settings.activeProject === name) {
            settings.activeProject = 'default';
        }
        saveWorkspace();
        return true;
    }
    return false;
}

export function renameProject(oldName, newName) {
    const settings = getSettings();
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to) {
        throw new Error('工作区名称不能为空');
    }
    if (from === to) {
        return true;
    }
    if (!settings.projects[from]) {
        throw new Error(`原工作区项目 "${from}" 不存在`);
    }
    if (settings.projects[to]) {
        throw new Error(`目标工作区项目 "${to}" 已存在`);
    }

    const proj = settings.projects[from];
    proj.name = to;
    proj.updatedAt = Date.now();
    settings.projects[to] = proj;
    delete settings.projects[from];

    if (settings.activeProject === from) {
        settings.activeProject = to;
    }
    saveWorkspace();
    return true;
}

export function normalizePath(path) {
    if (!path) return '';
    return path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

export function writeFile(filePath, content, mode = 'overwrite') {
    const project = getActiveProject();
    const path = normalizePath(filePath);
    if (!path) throw new Error('File path cannot be empty');

    let finalContent = content;
    const existing = project.files[path];

    if (mode === 'append' && existing) {
        finalContent = (existing.content || '') + '\n' + content;
    } else if (mode === 'create' && existing) {
        throw new Error(`File already exists: ${path}`);
    }

    project.files[path] = {
        content: finalContent,
        updatedAt: Date.now(),
    };
    project.updatedAt = Date.now();
    saveWorkspace();
    return { path, length: finalContent.length, mode };
}

export function readFile(filePath) {
    const project = getActiveProject();
    const path = normalizePath(filePath);
    if (!project.files[path]) {
        return null;
    }
    return project.files[path].content;
}

export function readFileSlice(filePath, startLine = null, endLine = null, withLineNumbers = true) {
    const rawContent = readFile(filePath);
    if (rawContent === null) return null;

    const lines = rawContent.split(/\r?\n/);
    const totalLines = lines.length;

    if (startLine === null && endLine === null) {
        return {
            content: rawContent,
            totalLines,
            isSliced: false,
            startLine: 1,
            endLine: totalLines,
            chars: rawContent.length
        };
    }

    const sLine = Math.max(1, parseInt(startLine, 10) || 1);
    const eLine = Math.min(totalLines, Math.max(sLine, parseInt(endLine, 10) || totalLines));

    const sliceArr = lines.slice(sLine - 1, eLine);
    let slicedContent = '';
    if (withLineNumbers) {
        const padLen = String(eLine).length;
        slicedContent = sliceArr
            .map((line, idx) => `${String(sLine + idx).padStart(padLen, ' ')}: ${line}`)
            .join('\n');
    } else {
        slicedContent = sliceArr.join('\n');
    }

    return {
        content: slicedContent,
        rawSlice: sliceArr.join('\n'),
        totalLines,
        isSliced: true,
        startLine: sLine,
        endLine: eLine,
        sliceLinesCount: sliceArr.length,
        chars: slicedContent.length
    };
}

export function deleteFile(filePath) {
    const project = getActiveProject();
    const path = normalizePath(filePath);
    if (project.files[path]) {
        delete project.files[path];
        project.updatedAt = Date.now();
        saveWorkspace();
        return true;
    }
    return false;
}

export function renameFile(oldPath, newPath) {
    const project = getActiveProject();
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (!from || !to) {
        throw new Error('草稿路径不能为空');
    }
    if (from === to) {
        return true;
    }
    if (!project.files[from]) {
        throw new Error(`原草稿文件不存在: ${from}`);
    }
    if (project.files[to]) {
        throw new Error(`目标草稿文件已存在: ${to}`);
    }

    project.files[to] = {
        ...project.files[from],
        updatedAt: Date.now()
    };
    delete project.files[from];
    project.updatedAt = Date.now();
    saveWorkspace();
    return true;
}

export function listFiles(prefix = '') {
    const project = getActiveProject();
    const normPrefix = normalizePath(prefix);
    const result = [];
    for (const [path, file] of Object.entries(project.files || {})) {
        if (!normPrefix || path.startsWith(normPrefix)) {
            result.push({
                path,
                length: file.content?.length || 0,
                updatedAt: file.updatedAt,
            });
        }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function searchFiles(query, options = {}) {
    if (!query) return [];
    const project = getActiveProject();
    const results = [];
    const lowerQuery = String(query).toLowerCase();
    
    // Support options as string (pathFilter) or object ({ path, maxResults })
    const pathFilter = typeof options === 'string' ? options : (options?.path || options?.prefix || '');
    const maxResultsPerFile = typeof options === 'object' && options?.maxResults ? options.maxResults : 50;

    for (const [rawPath, file] of Object.entries(project.files || {})) {
        const path = normalizePath(rawPath);
        if (pathFilter && !path.startsWith(normalizePath(pathFilter)) && path !== normalizePath(pathFilter)) {
            continue;
        }

        const content = file.content || '';
        const lowerContent = content.toLowerCase();
        const pathMatches = path.toLowerCase().includes(lowerQuery);
        const hasContentMatch = lowerContent.includes(lowerQuery);

        if (pathMatches || hasContentMatch) {
            const lines = content.split(/\r?\n/);
            const totalLines = lines.length;
            const lineMatches = [];

            if (hasContentMatch) {
                for (let i = 0; i < lines.length; i++) {
                    const lineText = lines[i];
                    if (lineText.toLowerCase().includes(lowerQuery)) {
                        lineMatches.push({
                            line: i + 1,
                            content: lineText.length > 300 ? lineText.substring(0, 300) + '...' : lineText
                        });
                        if (lineMatches.length >= maxResultsPerFile) break;
                    }
                }
            }

            // Also provide a concise snippet for backward compatibility
            let snippet = '';
            const contentIndex = lowerContent.indexOf(lowerQuery);
            if (contentIndex !== -1) {
                const start = Math.max(0, contentIndex - 60);
                const end = Math.min(content.length, contentIndex + query.length + 60);
                snippet = (start > 0 ? '...' : '') + content.substring(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : '');
            } else {
                snippet = content.substring(0, 100).replace(/\n/g, ' ');
            }

            results.push({
                path,
                pathMatches,
                totalLines,
                matchesCount: lineMatches.length,
                matches: lineMatches,
                snippet,
                length: content.length,
            });
        }
    }
    return results;
}

export function exportProjectData(name) {
    const settings = getSettings();
    const target = name || settings.activeProject;
    return JSON.stringify(settings.projects[target] || {}, null, 2);
}

export function importProjectData(name, jsonData) {
    const settings = getSettings();
    try {
        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid project JSON');
        settings.projects[name] = {
            name,
            description: parsed.description || '',
            files: parsed.files || {},
            createdAt: parsed.createdAt || Date.now(),
            updatedAt: Date.now(),
        };
        settings.activeProject = name;
        saveWorkspace();
        return true;
    } catch (e) {
        console.error('[Worldlore Agent] Failed to import project:', e);
        return false;
    }
}
