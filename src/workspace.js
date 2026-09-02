import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

export const EXTENSION_NAME = 'worldlore_agent';

export function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {
            enabled: true,
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
            },
        };
    }
    if (extension_settings[EXTENSION_NAME].enabled === undefined) {
        extension_settings[EXTENSION_NAME].enabled = true;
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

export function searchFiles(query) {
    if (!query) return [];
    const project = getActiveProject();
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const [path, file] of Object.entries(project.files || {})) {
        const pathMatches = path.toLowerCase().includes(lowerQuery);
        const content = file.content || '';
        const contentLower = content.toLowerCase();
        const contentIndex = contentLower.indexOf(lowerQuery);

        if (pathMatches || contentIndex !== -1) {
            let snippet = '';
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
