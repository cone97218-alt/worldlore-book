import { getSettings, saveWorkspace, getProjects, getActiveProjectName, getActiveProject, createProject, switchProject, deleteProject, renameProject, listFiles, readFile, writeFile, deleteFile, renameFile, exportProjectData, importProjectData } from '../core/workspace.js';
import { getStagingEntries, removeStagingEntry, clearStaging, applyStagingEntry, applyAllStaging, getHistoryEntries, undoHistoryRecord, redoHistoryRecord, restageHistoryRecord, clearHistory, getToolDocumentationPrompt, setToolMode, addStagingEntry, addHistoryRecord, isToolEnabled, setToolEnabled, TOOL_DEFINITIONS } from '../tools/index.js';
import { getAvailableWorldInfos, getCharacterBoundLorebooks, getCurrentCharacter, getCurrentPersona, getLorebooksOverview, readLorebookEntriesScoped } from '../st/st-sync.js';
import { importLorebookToWorkspace, importCharacterToWorkspace, importPersonaToWorkspace, parseFrontmatter, formatFrontmatter } from '../st/import-sync.js';
import { getRegexScripts, findRegexScript } from '../st/regex-sync.js';
import { loadWorldInfo } from '/scripts/world-info.js';
import { eventSource, event_types } from '/script.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { showDiffModal } from '../utils/diff.js';
import { showHtmlPreviewModal, buildIframeDoc, parseRegex, generateMockTextFromRegex } from '../utils/preview.js';
import { importBundledPresetToSillyTavern } from '../st/preset-sync.js';

/**
 * Renders a clean dropdown select dialog via SillyTavern's Popup
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.message
 * @param {Array<{value: string, label: string}>} params.options
 * @param {string} [params.defaultVal]
 * @returns {Promise<string|null>}
 */
export async function showSelectModal({ title = '请选择', message = '请选择目标项：', options = [], defaultVal = '' }) {
    if (!options || options.length === 0) return null;
    const container = document.createElement('div');
    container.style.cssText = 'display:flex; flex-direction:column; gap:12px; min-width:340px; font-size:13px; text-align:left;';

    const titleEl = document.createElement('div');
    titleEl.innerHTML = `<strong style="font-size:15px;">${title}</strong>`;
    container.appendChild(titleEl);

    const msgEl = document.createElement('div');
    msgEl.innerText = message;
    msgEl.style.opacity = '0.85';
    container.appendChild(msgEl);

    const select = document.createElement('select');
    select.className = 'text_pole';
    select.style.cssText = 'width:100%; padding:8px 10px; border-radius:5px; box-sizing:border-box;';

    for (const opt of options) {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        if (opt.value === defaultVal) {
            optionEl.selected = true;
        }
        select.appendChild(optionEl);
    }
    container.appendChild(select);

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: '确定',
        cancelButton: '取消',
    });

    const res = await popup.show();
    if (res) {
        return select.value;
    }
    return null;
}

let currentSelectedFile = null;
let toggleEditorPreviewMode = null;
let lastToggleTime = 0;
let currentFolderFilter = null;
let expandedFolders = new Set();
let folderTreeInitialized = false;

const THEMES = ['default', 'morandi-beige', 'morandi-gray'];
const THEME_NAMES = {
    'default': '跟随酒馆',
    'morandi-beige': '莫兰迪米色',
    'morandi-gray': '莫兰迪灰色'
};

const POSITION_NAMES = {
    0: '前置角色',
    1: '后置角色',
    2: '前置AN',
    3: '后置AN',
    4: '深度插入',
    5: '前置示例',
    6: '后置示例'
};

export function initUI() {
    applyTheme(getSettings().ui?.theme || 'default');
    createFloatingBall();
    createDrawer();
    bindMenuButton();
    bindEvents();
    initQrDraftPicker();
}

export function applyTheme(themeName) {
    const theme = THEMES.includes(themeName) ? themeName : 'default';
    document.documentElement.setAttribute('data-worldlore-theme', theme);
    const drawer = document.getElementById('worldlore_agent_drawer');
    if (drawer) drawer.setAttribute('data-worldlore-theme', theme);
    const ball = document.getElementById('worldlore_floating_ball');
    if (ball) ball.setAttribute('data-worldlore-theme', theme);
    const popover = document.getElementById('worldlore_qr_popover');
    if (popover) popover.setAttribute('data-worldlore-theme', theme);

    const settings = getSettings();
    if (settings.ui) settings.ui.theme = theme;
    saveWorkspace();
}

function cycleTheme() {
    const settings = getSettings();
    const current = settings.ui?.theme || 'default';
    const nextIdx = (THEMES.indexOf(current) + 1) % THEMES.length;
    const nextTheme = THEMES[nextIdx];
    applyTheme(nextTheme);
    toastr.info(`已切换主题: ${THEME_NAMES[nextTheme]}`);
}

/**
 * Creates the circular floating ball
 */
function createFloatingBall() {
    if (document.getElementById('worldlore_floating_ball')) return;

    const settings = getSettings();
    const initialTop = settings.ui?.ballTop ?? 240;
    const initialSide = settings.ui?.ballSide ?? 'right';
    const theme = settings.ui?.theme ?? 'default';
    const isEnabled = settings.enabled !== false;

    const ball = document.createElement('div');
    ball.id = 'worldlore_floating_ball';
    ball.className = `worldlore-ball docked-${initialSide}`;
    ball.setAttribute('data-worldlore-theme', theme);
    ball.style.top = `${initialTop}px`;
    if (initialSide === 'left') {
        ball.style.left = '0px';
        ball.style.right = 'auto';
    } else {
        ball.style.right = '0px';
        ball.style.left = 'auto';
    }

    if (!isEnabled) {
        ball.style.display = 'none';
    }

    ball.innerHTML = `
        <div class="worldlore-ball-circle" title="A助手 (拖动贴边，轻触打开)">
            <i class="fa-solid fa-book-atlas"></i>
            <span class="worldlore-badge-counter" style="display:none;">0</span>
        </div>
    `;

    document.body.appendChild(ball);
    makeDraggableAndDockable(ball);
    updateStagingCounter();
}

function makeDraggableAndDockable(el) {
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let startTime = 0;
    let isTracking = false;
    let hasDragged = false;
    const DRAG_THRESHOLD = 8;

    const onStart = (e) => {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        startX = clientX;
        startY = clientY;
        startTime = Date.now();

        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        isTracking = true;
        hasDragged = false;

        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('mouseup', onEnd, { capture: true });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd, { capture: true });
    };

    const onMove = (e) => {
        if (!isTracking) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const deltaX = clientX - startX;
        const deltaY = clientY - startY;

        if (!hasDragged && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD) {
            hasDragged = true;
            el.classList.remove('docked-left', 'docked-right');
            el.classList.add('is-dragging');
        }

        if (hasDragged) {
            const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, initialLeft + deltaX));
            const newTop = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, initialTop + deltaY));

            el.style.left = `${newLeft}px`;
            el.style.right = 'auto';
            el.style.top = `${newTop}px`;
            if (e.cancelable) e.preventDefault();
        }
    };

    const onEnd = (e) => {
        if (!isTracking) return;
        isTracking = false;

        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd, { capture: true });
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd, { capture: true });

        const duration = Date.now() - startTime;

        if (!hasDragged || duration < 250) {
            el.classList.remove('is-dragging');
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            toggleDrawer(true);
            return;
        }

        el.classList.remove('is-dragging');

        const rect = el.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        const snapToRight = center > (window.innerWidth / 2);

        const settings = getSettings();
        if (snapToRight) {
            el.style.left = 'auto';
            el.style.right = '0px';
            el.classList.add('docked-right');
            settings.ui.ballSide = 'right';
        } else {
            el.style.left = '0px';
            el.style.right = 'auto';
            el.classList.add('docked-left');
            settings.ui.ballSide = 'left';
        }

        const finalTop = Math.max(20, Math.min(window.innerHeight - rect.height - 20, rect.top));
        el.style.top = `${finalTop}px`;
        settings.ui.ballTop = finalTop;
        saveWorkspace();
    };

    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: true });
}

/**
 * Toggles master extension enabled state and floating ball visibility
 */
export function toggleExtensionEnabled() {
    const settings = getSettings();
    const cur = settings.enabled !== false;
    const next = !cur;
    settings.enabled = next;
    saveWorkspace();

    const ball = document.getElementById('worldlore_floating_ball');
    if (next) {
        if (ball) ball.style.display = 'block';
        mountQrDraftButton();
        toastr.success('已开启 A助手');
    } else {
        if (ball) ball.style.display = 'none';
        toggleDrawer(false);
        unmountQrDraftButton();
        toastr.info('已关闭 A助手');
    }

    updateMenuItemState();
}

function updateMenuItemState() {
    const item = document.getElementById('worldlore_menu_item');
    if (!item) return;
    const settings = getSettings();
    const isEnabled = settings.enabled !== false;
    item.classList.toggle('active', isEnabled);
}

function bindMenuButton() {
    const interval = setInterval(() => {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('worldlore_menu_item')) {
            const item = document.createElement('div');
            item.id = 'worldlore_menu_item';
            item.className = 'extension_menu_item list-group-item flex-container flexGap5';
            item.title = '点击开启/关闭 A助手 (悬浮球显示与隐藏)';
            item.innerHTML = `
                <i class="fa-solid fa-book-atlas"></i>
                <span class="worldlore-nowrap-text">A助手</span>
            `;
            item.addEventListener('click', () => {
                toggleExtensionEnabled();
            });
            menu.appendChild(item);
            updateMenuItemState();
            clearInterval(interval);
        }
    }, 1000);
}


const IN_DRAWER_PREVIEW_INJECTED_CSS = `
.worldlore-in-drawer-preview {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 !important;
    min-height: 460px !important;
    height: 100% !important;
    width: 100% !important;
    border: 1px solid var(--wl-border, #3e445b) !important;
    border-radius: 6px !important;
    overflow: hidden !important;
    background: var(--wl-bg-main, #1b1e2e) !important;
    box-sizing: border-box !important;
    writing-mode: horizontal-tb !important;
    direction: ltr !important;
}
.in-drawer-preview-toolbar {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 6px 10px !important;
    background: var(--wl-bg-sub, #161926) !important;
    border-bottom: 1px solid var(--wl-border, #3e445b) !important;
    gap: 8px !important;
    flex-shrink: 0 !important;
    flex-wrap: nowrap !important;
    writing-mode: horizontal-tb !important;
    box-sizing: border-box !important;
}
.in-drawer-preview-toolbar * {
    writing-mode: horizontal-tb !important;
    direction: ltr !important;
    white-space: nowrap !important;
}
.preview-tb-left,
.preview-tb-right {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 6px !important;
    flex-shrink: 0 !important;
    flex-wrap: nowrap !important;
}
.preview-mini-seg {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    background: var(--wl-bg-input, #282c3f) !important;
    border: 1px solid var(--wl-border, #3e445b) !important;
    border-radius: 5px !important;
    padding: 2px !important;
    gap: 2px !important;
}
.preview-mini-seg-btn {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 4px !important;
    white-space: nowrap !important;
    padding: 3px 8px !important;
    font-size: 11px !important;
    line-height: 1 !important;
    height: 24px !important;
    border-radius: 4px !important;
    border: none !important;
    background: transparent !important;
    color: var(--wl-text-main) !important;
    opacity: 0.7 !important;
    cursor: pointer !important;
    transition: all 0.15s ease !important;
}
.preview-mini-seg-btn.active {
    opacity: 1 !important;
    background: var(--wl-active-bg, #f39c12) !important;
    color: var(--wl-active-text, #000) !important;
    font-weight: 600 !important;
}
.preview-tb-btn {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: center !important;
    min-width: 24px !important;
    gap: 4px !important;
    white-space: nowrap !important;
    padding: 3px 6px !important;
    font-size: 11px !important;
    line-height: 1 !important;
    height: 24px !important;
    border-radius: 4px !important;
    border: 1px solid var(--wl-border, #3e445b) !important;
    background: var(--wl-bg-input, #282c3f) !important;
    color: var(--wl-text-main) !important;
    cursor: pointer !important;
    transition: all 0.15s ease !important;
}
.preview-tb-btn:hover {
    border-color: var(--wl-accent, #f39c12) !important;
}
.preview-tb-btn.active {
    border-color: var(--wl-accent, #f39c12) !important;
    color: var(--wl-accent, #f39c12) !important;
}
.in-drawer-regex-test-bar {
    display: none !important;
    flex-direction: column !important;
    padding: 8px 10px !important;
    background: var(--wl-bg-sub, #161926) !important;
    border-bottom: 1px solid var(--wl-border, #3e445b) !important;
    gap: 6px !important;
    flex-shrink: 0 !important;
}
.in-drawer-regex-test-bar.open {
    display: flex !important;
}
.regex-test-info-line {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 8px !important;
}
.regex-test-pattern {
    font-size: 11px !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    background: var(--wl-bg-input, #282c3f) !important;
    border: 1px solid var(--wl-border, #3e445b) !important;
    color: var(--wl-accent, #f39c12) !important;
    max-width: 220px !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    font-family: Consolas, Monaco, monospace !important;
}
.regex-test-actions {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 6px !important;
    flex-shrink: 0 !important;
}
.regex-test-match-badge {
    font-size: 10px !important;
    padding: 2px 6px !important;
    border-radius: 8px !important;
    white-space: nowrap !important;
    background: rgba(0,0,0,0.1) !important;
}
.regex-test-match-badge.success {
    background: rgba(46, 204, 113, 0.2) !important;
    color: #2ecc71 !important;
    border: 1px solid rgba(46, 204, 113, 0.4) !important;
}
.regex-test-match-badge.warn {
    background: rgba(243, 156, 18, 0.2) !important;
    color: #f39c12 !important;
    border: 1px solid rgba(243, 156, 18, 0.4) !important;
}
.regex-test-textarea {
    min-height: 48px !important;
    max-height: 90px !important;
    font-size: 11px !important;
    resize: vertical !important;
    width: 100% !important;
    margin: 0 !important;
    box-sizing: border-box !important;
}
.in-drawer-preview-viewport {
    flex: 1 !important;
    min-height: 420px !important;
    height: 100% !important;
    width: 100% !important;
    display: flex !important;
    overflow: hidden !important;
    background: var(--wl-bg-main, #1b1e2e) !important;
    box-sizing: border-box !important;
}
.in-drawer-preview-iframe {
    width: 100% !important;
    height: 100% !important;
    min-height: 420px !important;
    flex: 1 !important;
    border: none !important;
    background: transparent !important;
    box-sizing: border-box !important;
}
.in-drawer-preview-source {
    width: 100% !important;
    height: 100% !important;
    min-height: 420px !important;
    margin: 0 !important;
    padding: 10px !important;
    overflow: auto !important;
    font-size: 11px !important;
    font-family: Consolas, Monaco, monospace !important;
    white-space: pre-wrap !important;
    word-break: break-all !important;
    background: var(--wl-bg-sub, #161926) !important;
    color: var(--wl-text-main) !important;
    box-sizing: border-box !important;
}
`;

function ensureInDrawerPreviewStyles() {
    let tag = document.getElementById('worldlore-in-drawer-injected-styles');
    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'worldlore-in-drawer-injected-styles';
        tag.textContent = IN_DRAWER_PREVIEW_INJECTED_CSS;
        document.head.appendChild(tag);
    } else {
        tag.textContent = IN_DRAWER_PREVIEW_INJECTED_CSS;
    }
}


function createDrawer() {
    ensureInDrawerPreviewStyles();
    if (document.getElementById('worldlore_agent_drawer')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'worldlore_drawer_backdrop';
    backdrop.className = 'worldlore-backdrop';
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
            toggleDrawer(false);
        }
    });
    document.body.appendChild(backdrop);

    const settings = getSettings();
    const theme = settings.ui?.theme || 'default';
    const panelOpen = settings.ui?.workspacePanelOpen || false;

    const drawer = document.createElement('div');
    drawer.id = 'worldlore_agent_drawer';
    drawer.className = 'worldlore-drawer';
    drawer.setAttribute('data-worldlore-theme', theme);
    drawer.innerHTML = `
        <!-- MERGED SINGLE-ROW HEADER: TABS + THEME + CLOSE -->
        <div class="worldlore-drawer-header merged-header">
            <div class="worldlore-drawer-nav">
                <button class="worldlore-tab-btn active" data-tab="workspace" title="设定工作区">
                    <i class="fa-solid fa-folder-tree"></i>
                </button>
                <button class="worldlore-tab-btn" data-tab="staging" title="待同步变更">
                    <i class="fa-solid fa-code-compare"></i>
                    <span class="worldlore-tab-counter" style="display:none;">0</span>
                </button>
                <button class="worldlore-tab-btn" data-tab="history" title="操作日志与撤回">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                </button>
                <button class="worldlore-tab-btn" data-tab="guide" title="扩展设置与工具管理">
                    <i class="fa-solid fa-sliders"></i>
                </button>
            </div>
            <div class="worldlore-header-actions">
                <button id="worldlore_theme_btn" class="menu_button fa-solid fa-palette" title="切换主题: 跟随酒馆 / 莫兰迪米色 / 莫兰迪灰色"></button>
                <button id="worldlore_drawer_close" class="menu_button fa-solid fa-xmark" title="关闭"></button>
            </div>
        </div>

        <div class="worldlore-drawer-content">
            <!-- TAB 1: WORKSPACE -->
            <div class="worldlore-tab-pane active" id="worldlore_pane_workspace">
                
                <!-- Unified Collapsible Project & File Management Bar (默认折叠) -->
                <div class="worldlore-workspace-unified-collapsible ${panelOpen ? 'open' : ''}">
                    <div class="workspace-collapse-trigger" id="worldlore_workspace_collapse_trigger">
                        <div class="workspace-current-meta">
                            <span class="meta-tag project-tag worldlore-nowrap-text"><i class="fa-solid fa-folder"></i> <span id="worldlore_cur_proj_name">default</span></span>
                            <span class="meta-tag file-tag worldlore-nowrap-text"><i class="fa-solid fa-file-lines"></i> <span id="worldlore_cur_file_name">未选择</span></span>
                        </div>
                        <div class="workspace-trigger-actions">
                            <button id="worldlore_new_file_quick_btn" class="menu_button fa-solid fa-file-circle-plus" title="新建草稿"></button>
                            <button id="worldlore_panel_toggle_btn" class="menu_button fa-solid ${panelOpen ? 'fa-chevron-up' : 'fa-chevron-down'}" title="展开/折叠项目与文件列表"></button>
                        </div>
                    </div>

                    <!-- Collapsed Panel Body: Project Bar + Search + Spacious File List -->
                    <div class="workspace-collapse-body" id="worldlore_workspace_collapse_body" style="${panelOpen ? 'display:flex;' : 'display:none;'}">
                        <!-- Project actions -->
                        <div class="workspace-project-subbar">
                            <select id="worldlore_project_select" class="worldlore-select"></select>
                            <button id="worldlore_new_project_btn" class="menu_button fa-solid fa-plus" title="新建项目"></button>
                            <button id="worldlore_rename_project_btn" class="menu_button fa-solid fa-pen-to-square" title="重命名当前项目"></button>
                            <button id="worldlore_export_project_btn" class="menu_button fa-solid fa-file-export" title="导出项目"></button>
                            <button id="worldlore_import_project_btn" class="menu_button fa-solid fa-file-import" title="导入项目"></button>
                            <button id="worldlore_delete_project_btn" class="menu_button fa-solid fa-trash" title="删除项目"></button>
                            <input type="file" id="worldlore_import_file_input" style="display:none;" accept=".json" />
                        </div>

                        <!-- Pure Icon Quick Pull & Template Toolbar -->
                        <div class="workspace-quick-toolbar">
                            <button id="worldlore_quick_pull_lorebook_btn" class="menu_button fa-solid fa-book-bookmark" title="拉取当前世界书到工坊 (方案C)"></button>
                            <button id="worldlore_quick_pull_character_btn" class="menu_button fa-solid fa-user-tag" title="拉取当前角色卡设定到工坊"></button>
                            <button id="worldlore_quick_pull_persona_btn" class="menu_button fa-solid fa-user-pen" title="拉取当前用户人设到工坊"></button>
                            <button id="worldlore_quick_pull_regex_btn" class="menu_button fa-solid fa-code" title="拉取酒馆正则脚本到工坊"></button>
                            <div class="quick-toolbar-divider"></div>
                            <button id="worldlore_quick_new_template_btn" class="menu_button fa-solid fa-file-circle-plus" title="新建标准草稿模板 (世界书/正则)"></button>
                        </div>

                        <!-- Search file -->
                        <input type="text" id="worldlore_file_search_input" class="worldlore-input" placeholder="搜索草稿文件..." />

                        <!-- Top Folder Filter Pills Bar -->
                        <div id="worldlore_folder_filter_pills" class="worldlore-folder-filter-pills" style="display:none;"></div>

                        <!-- Spacious File List Container -->
                        <div id="worldlore_file_list" class="worldlore-file-list unified-spacious-list"></div>
                    </div>
                </div>

                <!-- Full-Height Editor Body -->
                <div class="worldlore-editor-full-container">
                    <div class="worldlore-editor-header" style="display:flex; flex-direction:row; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px; width:100%; min-width:0; flex-wrap:nowrap; box-sizing:border-box;">
                        <div class="editor-filename-wrap" style="display:flex; align-items:center; min-width:0; flex:1 1 0; overflow:hidden; gap:5px; color:var(--wl-accent); box-sizing:border-box;">
                            <i class="fa-solid fa-pen-to-square" style="flex-shrink:0; font-size:12px;"></i>
                            <span id="worldlore_editor_filename" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:12px; min-width:0; flex:1;" title="当前编辑的文件路径">world/overview.md</span>
                        </div>
                        <div class="worldlore-editor-actions" style="display:flex; align-items:center; justify-content:flex-end; gap:4px; flex-shrink:0; flex-wrap:nowrap; box-sizing:border-box;">
                            <button id="worldlore_push_editor_file_btn" class="menu_button primary fa-solid fa-rocket" title="一键推送到酒馆待确认审核区"></button>
                            <button id="worldlore_diff_editor_file_btn" class="menu_button fa-solid fa-code-compare" title="对比草稿与酒馆线上版本 (Diff)"></button>
                            <button id="worldlore_preview_html_btn" class="menu_button fa-solid fa-eye" title="前端预览 HTML / 正则渲染效果"></button>
                            <button id="worldlore_save_file_btn" class="menu_button fa-solid fa-floppy-disk" title="保存草稿"></button>
                            <button id="worldlore_rename_file_btn" class="menu_button fa-solid fa-pen-to-square" title="重命名草稿"></button>
                            <button id="worldlore_delete_file_btn" class="menu_button fa-solid fa-trash" title="删除草稿"></button>
                        </div>
                    </div>
                    <textarea id="worldlore_file_editor" class="worldlore-textarea editor-fullscreen" placeholder="在上方展开栏中选择文件查看与编辑，或由 Agent 写入..."></textarea>
                    <!-- In-Drawer Live Preview Container -->
                    <div id="worldlore_editor_preview_container" class="worldlore-in-drawer-preview displayNone" style="display:none; width:100%; flex:1; min-height:460px; height:100%; flex-direction:column; box-sizing:border-box;">
                        <div class="in-drawer-preview-toolbar" id="wl_preview_top_bar" style="display:flex; flex-direction:row; align-items:center; justify-content:space-between; padding:6px 10px; gap:8px; flex-wrap:nowrap; flex-shrink:0;">
                            <div class="preview-tb-left" style="display:inline-flex; flex-direction:row; align-items:center; gap:6px; flex-wrap:nowrap;">
                                <button class="menu_button preview-tb-btn fa-solid fa-flask" id="wl_preview_test_toggle_btn" title="展开/收起正则模拟联调测试框"></button>
                                <code class="regex-test-pattern" id="wl_preview_pattern_display" style="display:inline-block; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title=""></code>
                            </div>
                            <div class="preview-tb-right" style="display:inline-flex; flex-direction:row; align-items:center; gap:6px; flex-wrap:nowrap; flex-shrink:0;">
                                <span class="regex-test-match-badge" id="wl_preview_match_badge"></span>
                                <button class="menu_button preview-tb-btn fa-solid fa-wand-magic-sparkles" id="wl_preview_fill_mock_btn" title="一键填充模拟对话数据"></button>
                            </div>
                        </div>
                        <div class="in-drawer-regex-test-bar" id="wl_preview_regex_test_bar" style="display:none; flex-direction:column; gap:6px; padding:6px 10px;">
                            <textarea id="wl_preview_test_input" class="worldlore-input regex-test-textarea" placeholder="输入测试对话文本，实时查看正则替换效果..."></textarea>
                        </div>
                        <div class="in-drawer-preview-viewport" style="flex:1; width:100%; height:100%; min-height:420px; display:flex; box-sizing:border-box;">
                            <iframe id="worldlore_in_drawer_iframe" class="in-drawer-preview-iframe" style="width:100%; height:100%; min-height:420px; border:none; flex:1;" sandbox="allow-scripts allow-same-origin"></iframe>
                        </div>
                    </div>
                </div>
            </div>

            <!-- TAB 2: STAGING -->
            <div class="worldlore-tab-pane" id="worldlore_pane_staging">
                <div class="worldlore-staging-header">
                    <div class="staging-stats">
                        <span id="worldlore_staging_count_text" class="worldlore-nowrap-text">0 项待确认变更</span>
                    </div>
                    <div class="staging-actions">
                        <button id="worldlore_apply_all_btn" class="menu_button primary fa-solid fa-check-double" title="一键全部同步到 ST"></button>
                        <button id="worldlore_clear_staging_btn" class="menu_button fa-solid fa-trash-can" title="全部清空"></button>
                    </div>
                </div>
                <div id="worldlore_staging_list" class="worldlore-staging-list"></div>
            </div>

            <!-- TAB 3: HISTORY & UNDO / REDO / RE-STAGE -->
            <div class="worldlore-tab-pane" id="worldlore_pane_history">
                <div class="worldlore-staging-header">
                    <div class="staging-stats">
                        <span id="worldlore_history_count_text" class="worldlore-nowrap-text">0 条操作记录</span>
                    </div>
                    <div class="staging-actions">
                        <button id="worldlore_clear_history_btn" class="menu_button fa-solid fa-trash-can" title="清空历史记录"></button>
                    </div>
                </div>
                <div id="worldlore_history_list" class="worldlore-history-list"></div>
            </div>

            <!-- TAB 4: SETTINGS & TOOLS MANAGER -->
            <div class="worldlore-tab-pane" id="worldlore_pane_guide">
                <div class="worldlore-guide-container">
                    <div class="worldlore-guide-header">
                        <i class="fa-solid fa-sliders"></i>
                        <span class="worldlore-nowrap-text">A助手 扩展设置</span>
                    </div>

                    <!-- MOBILE GESTURE & INTERACTION SETTING -->
                    <div class="worldlore-setting-row" style="display:flex !important; flex-direction:row !important; align-items:center !important; justify-content:space-between !important; margin:6px 0 10px 0 !important; padding:8px 12px !important; background:var(--wl-bg-sub) !important; border:1px solid var(--wl-border) !important; border-radius:6px !important; box-sizing:border-box !important;">
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <span class="worldlore-nowrap-text" style="font-size:12px; font-weight:600;">滑动退出弹窗</span>
                            <span style="font-size:10px; opacity:0.75;">支持移动端或触屏向右滑动手势快速关闭抽屉</span>
                        </div>
                        <input type="checkbox" id="worldlore_swipe_to_close_chk" style="cursor:pointer; width:16px; height:16px; accent-color:var(--wl-accent);" />
                    </div>

                    <!-- PRESET IMPORT -->
                    <div class="worldlore-preset-simple-bar" style="display:flex !important; flex-direction:row !important; align-items:center !important; justify-content:space-between !important; width:100% !important; margin:6px 0 10px 0 !important; box-sizing:border-box !important;">
                        <span class="worldlore-nowrap-text" style="font-size:13px !important; font-weight:600 !important; white-space:nowrap !important; margin:0 !important; line-height:1 !important;">A助手预设</span>
                        <button id="worldlore_import_preset_btn" class="menu_button worldlore-preset-btn" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:6px !important; white-space:nowrap !important; width:auto !important; min-width:max-content !important; height:auto !important; min-height:28px !important; padding:4px 12px !important; font-size:12px !important; margin:0 !important; line-height:1 !important; cursor:pointer !important;" title="导入内置预设到酒馆">
                            <i class="fa-solid fa-file-import" style="margin:0 !important; font-size:12px !important; line-height:1 !important;"></i>
                            <span class="worldlore-nowrap-text" style="margin:0 !important; white-space:nowrap !important; line-height:1 !important;">导入预设</span>
                        </button>
                    </div>

                    <div class="worldlore-section-label worldlore-nowrap-text">工具运行模式</div>
                    <div class="worldlore-mode-toggle" id="worldlore_mode_toggle">
                        <button id="worldlore_mode_native_btn" class="menu_button worldlore-mode-btn" title="原生 Function Calling 模式 (走 API 协议)">
                            <i class="fa-solid fa-plug"></i>
                        </button>
                        <button id="worldlore_mode_text_btn" class="menu_button worldlore-mode-btn" title="文本标签模式 (<agent_action> 标签)">
                            <i class="fa-solid fa-tag"></i>
                        </button>
                    </div>
                    <div id="worldlore_mode_label" class="worldlore-mode-label worldlore-nowrap-text"></div>

                    <!-- TOOLS CHECKBOX SECTION (有条理地列出可使用工具供勾选) -->
                    <div class="worldlore-tools-manager-section">
                        <div class="tools-manager-header">
                            <span class="worldlore-section-label worldlore-nowrap-text" style="margin:0;">可用 AI 工具管理</span>
                            <div class="tools-manager-actions">
                                <button id="worldlore_select_all_tools_btn" class="menu_button text-btn" title="全部启用">全选</button>
                                <button id="worldlore_deselect_all_tools_btn" class="menu_button text-btn" title="全部禁用">清空</button>
                            </div>
                        </div>
                        <div id="worldlore_tools_checkbox_list" class="worldlore-tools-checkbox-list"></div>
                    </div>

                    <!-- 文本模式提示词与全局宏区域（原生模式下彻底隐藏） -->
                    <div id="worldlore_copy_prompt_section" style="margin-top:14px;">
                        <div id="worldlore_macro_section_title" class="worldlore-section-label worldlore-nowrap-text">预设宏与提示词</div>
                        <p id="worldlore_macro_section_desc" style="font-size:12px; opacity:0.85; margin-bottom:8px; line-height:1.5;">
                            已自动注册酒馆全局宏 <code>{{worldlore_tools}}</code>，可直接在预设任意位置插入！发送时将根据当前模式和勾选工具实时动态注入。
                        </p>
                        <div class="macro-badge-row">
                            <div id="worldlore_copy_macro_btn" class="macro-code-pill" title="点击一键复制宏标记 {{worldlore_tools}}">
                                <code>{{worldlore_tools}}</code>
                                <i class="fa-regular fa-copy"></i>
                            </div>
                            <button id="worldlore_copy_prompt_btn" class="menu_button primary fa-solid fa-file-code" title="一键复制当前模式提示词"></button>
                        </div>
                    </div>

                    <div class="worldlore-status-summary" style="margin-top:14px;">
                        <div class="summary-item"><i class="fa-solid fa-user"></i> <span id="worldlore_stat_char" class="worldlore-nowrap-text">未选定</span></div>
                        <div class="summary-item"><i class="fa-solid fa-user-gear"></i> <span id="worldlore_stat_persona" class="worldlore-nowrap-text">默认</span></div>
                        <div class="summary-item"><i class="fa-solid fa-book"></i> <span id="worldlore_stat_wi" class="worldlore-nowrap-text">0 本</span></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(drawer);
}

function bindEvents() {
    $('#worldlore_drawer_close').on('click', () => toggleDrawer(false));
    $('#worldlore_theme_btn').on('click', cycleTheme);

    // --- MOBILE TOUCH SWIPE TO CLOSE DRAWER ---
    const currentSettings = getSettings();
    const swipeChk = $('#worldlore_swipe_to_close_chk');
    if (swipeChk.length) {
        swipeChk.prop('checked', currentSettings.ui?.swipeToClose !== false);
        swipeChk.on('change', function () {
            const val = $(this).is(':checked');
            if (!currentSettings.ui) currentSettings.ui = {};
            currentSettings.ui.swipeToClose = val;
            saveWorkspace();
            toastr.info(`滑动退出弹窗已${val ? '开启' : '关闭'}`);
        });
    }

    const drawerEl = document.getElementById('worldlore_agent_drawer');
    if (drawerEl) {
        let touchStartX = 0;
        let touchStartY = 0;
        let isTouching = false;
        let isFromHeader = false;

        drawerEl.addEventListener('touchstart', (e) => {
            const s = getSettings();
            if (s.ui?.swipeToClose === false) return;
            if (e.touches.length !== 1) return;

            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isTouching = true;
            isFromHeader = !!e.target.closest('.worldlore-drawer-header');
        }, { passive: true });

        drawerEl.addEventListener('touchend', (e) => {
            if (!isTouching) return;
            isTouching = false;
            const s = getSettings();
            if (s.ui?.swipeToClose === false) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;

            // 1. Right swipe gesture: slide out drawer to the right
            if (deltaX > 70 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
                toggleDrawer(false);
                return;
            }

            // 2. Header downward swipe gesture
            if (isFromHeader && deltaY > 60 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
                toggleDrawer(false);
                return;
            }
        }, { passive: true });
    }

    $('.worldlore-tab-btn').on('click', function () {
        const tab = $(this).data('tab');
        switchTab(tab);
    });

    const toggleWorkspacePanel = () => {
        const settings = getSettings();
        const el = $('.worldlore-workspace-unified-collapsible');
        const body = $('#worldlore_workspace_collapse_body');
        const btn = $('#worldlore_panel_toggle_btn');

        if (el.hasClass('open')) {
            el.removeClass('open');
            body.slideUp(160);
            btn.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            settings.ui.workspacePanelOpen = false;
        } else {
            el.addClass('open');
            body.slideDown(160);
            btn.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            settings.ui.workspacePanelOpen = true;
        }
        saveWorkspace();
    };

    $('#worldlore_workspace_collapse_trigger').on('click', function (e) {
        if ($(e.target).closest('#worldlore_new_file_quick_btn').length > 0) return;
        toggleWorkspacePanel();
    });

    $('#worldlore_project_select').on('change', function () {
        const name = $(this).val();
        switchProject(name);
        $('#worldlore_cur_proj_name').text(name);
        currentFolderFilter = null;
        expandedFolders.clear();
        folderTreeInitialized = false;
        refreshWorkspaceUI();
    });

    $('#worldlore_new_project_btn').on('click', async () => {
        const name = await Popup.show.input('新建写卡项目', '输入新项目名称', '');
        if (name && createProject(name.trim())) {
            toastr.success(`已创建并切换到项目: ${name}`);
            $('#worldlore_cur_proj_name').text(name.trim());
            refreshWorkspaceUI();
        }
    });

    $('#worldlore_rename_project_btn').on('click', async () => {
        const cur = getActiveProjectName();
        const newName = await Popup.show.input('重命名工作区项目', '输入新的工作区名称：', cur);
        if (newName && newName.trim() && newName.trim() !== cur) {
            try {
                renameProject(cur, newName.trim());
                addHistoryRecord({
                    type: 'workspace',
                    action: 'rename_project',
                    target: newName.trim(),
                    summary: `重命名工作区: ${cur} ➔ ${newName.trim()}`,
                    beforeState: { name: cur },
                    afterState: { name: newName.trim() },
                    canUndo: true,
                });
                toastr.success(`工作区已重命名为: ${newName.trim()}`);
                $('#worldlore_cur_proj_name').text(newName.trim());
                refreshWorkspaceUI();
            } catch (e) {
                toastr.error(`重命名失败: ${e.message}`);
            }
        }
    });

    $('#worldlore_delete_project_btn').on('click', async () => {
        const cur = getActiveProjectName();
        const conf = await Popup.show.confirm('删除项目', `确定要删除项目 "${cur}" 及其所有草稿文件吗？`);
        if (conf) {
            deleteProject(cur);
            toastr.info(`已删除项目 ${cur}`);
            $('#worldlore_cur_proj_name').text(getActiveProjectName());
            refreshWorkspaceUI();
        }
    });

    $('#worldlore_export_project_btn').on('click', () => {
        const cur = getActiveProjectName();
        const data = exportProjectData(cur);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `worldlore_project_${cur}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $('#worldlore_import_project_btn').on('click', () => {
        $('#worldlore_import_file_input').trigger('click');
    });

    $('#worldlore_import_file_input').on('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
            const name = file.name.replace(/\.json$/i, '').replace(/^worldlore_project_/i, '');
            if (importProjectData(name, evt.target.result)) {
                toastr.success(`项目 "${name}" 导入成功！`);
                $('#worldlore_cur_proj_name').text(name);
                refreshWorkspaceUI();
            } else {
                toastr.error('导入失败，无效的 JSON 数据');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    $('#worldlore_new_file_quick_btn').on('click', async (e) => {
        e.stopPropagation();
        const filename = await Popup.show.input('新建草稿文件', '输入相对路径及文件名 (例如: world/factions.md)', 'draft.md');
        if (filename) {
            writeFile(filename.trim(), '# ' + filename + '\n\n');
            currentSelectedFile = filename.trim();
            refreshWorkspaceUI();
            loadFileToEditor(currentSelectedFile);
        }
    });

    $('#worldlore_save_file_btn').on('click', () => {
        if (!currentSelectedFile) return;
        const val = $('#worldlore_file_editor').val();
        writeFile(currentSelectedFile, val);
        toastr.success(`已保存: ${currentSelectedFile}`);
        refreshWorkspaceUI();
    });

    const promptRenameFile = async (targetPath) => {
        const oldPath = targetPath || currentSelectedFile;
        if (!oldPath) return;
        const newPath = await Popup.show.input('重命名草稿文件', '输入新的草稿路径及文件名 (如 world/magic.md)：', oldPath);
        if (newPath && newPath.trim() && newPath.trim() !== oldPath) {
            try {
                renameFile(oldPath, newPath.trim());
                addHistoryRecord({
                    type: 'workspace',
                    action: 'rename',
                    target: newPath.trim(),
                    summary: `重命名草稿: ${oldPath} ➔ ${newPath.trim()}`,
                    beforeState: { path: oldPath },
                    afterState: { path: newPath.trim() },
                    canUndo: true,
                });
                toastr.success(`草稿已重命名为: ${newPath.trim()}`);
                if (currentSelectedFile === oldPath) {
                    currentSelectedFile = newPath.trim();
                }
                refreshWorkspaceUI();
                loadFileToEditor(currentSelectedFile);
            } catch (e) {
                toastr.error(`重命名失败: ${e.message}`);
            }
        }
    };

    $('#worldlore_rename_file_btn').on('click', () => {
        if (!currentSelectedFile) return;
        promptRenameFile(currentSelectedFile);
    });

    $('#worldlore_delete_file_btn').on('click', async () => {
        if (!currentSelectedFile) return;
        const conf = await Popup.show.confirm('删除文件', `确定删除草稿 "${currentSelectedFile}" 吗？`);
        if (conf) {
            deleteFile(currentSelectedFile);
            currentSelectedFile = null;
            refreshWorkspaceUI();
            $('#worldlore_file_editor').val('');
            $('#worldlore_editor_filename').text('未选择文件');
            $('#worldlore_cur_file_name').text('未选择');
            $('#worldlore_save_file_btn, #worldlore_delete_file_btn, #worldlore_rename_file_btn, #worldlore_push_editor_file_btn, #worldlore_diff_editor_file_btn, #worldlore_preview_html_btn').hide();
        }
    });

    // --- QUICK ACTION BUTTONS: PUSH & DIFF FROM EDITOR ---
    $('#worldlore_push_editor_file_btn').on('click', () => {
        if (!currentSelectedFile) return;
        const val = $('#worldlore_file_editor').val();
        writeFile(currentSelectedFile, val);
        pushDraftFileToStaging(currentSelectedFile);
    });

    $('#worldlore_diff_editor_file_btn').on('click', () => {
        if (!currentSelectedFile) return;
        diffDraftFileWithST(currentSelectedFile);
    });

    // ==========================================
    // IN-DRAWER PREVIEW CONTROLLER
    // ==========================================
    let isEditorPreviewActive = false;
    let inDrawerRegexMeta = null;

    function getRegexAssetInfo(path) {
        if (!path || !path.startsWith('regex/')) return null;
        const parts = path.split('/');
        const folder = parts.slice(0, 2).join('/');
        const metaPath = `${folder}/meta.json`;
        const replaceHtmlPath = `${folder}/replace.html`;

        let meta = null;
        const metaText = (currentSelectedFile === metaPath)
            ? $('#worldlore_file_editor').val()
            : readFile(metaPath);
        if (metaText) {
            try { meta = JSON.parse(metaText); } catch (e) {}
        }
        const scriptName = meta?.scriptName || folder.split('/').pop() || '正则脚本';

        let htmlContent = '';
        if (currentSelectedFile === replaceHtmlPath) {
            htmlContent = $('#worldlore_file_editor').val() || '';
        } else {
            htmlContent = readFile(replaceHtmlPath);
            if (htmlContent === null || htmlContent === undefined) {
                htmlContent = '<div style="color:var(--wl-text-muted);padding:24px;text-align:center;font-size:14px;">（该正则草稿尚未创建 replace.html 模板代码）</div>';
            }
        }

        return { folder, metaPath, replaceHtmlPath, meta, scriptName, htmlContent };
    }

    function updateInDrawerPreview() {
        if (!currentSelectedFile) return;

        let finalHtml = '';
        const regexAsset = getRegexAssetInfo(currentSelectedFile);

        if (regexAsset) {
            inDrawerRegexMeta = regexAsset.meta;
            const findRegexStr = regexAsset.meta?.findRegex || '';
            const compiled = parseRegex(findRegexStr);

            $('#wl_preview_top_bar').show();
            $('#wl_preview_pattern_display').text(findRegexStr).attr('title', findRegexStr);

            let testInputVal = $('#wl_preview_test_input').val();
            if (!testInputVal && findRegexStr) {
                testInputVal = generateMockTextFromRegex(findRegexStr);
                $('#wl_preview_test_input').val(testInputVal);
            }

            let matchCount = 0;
            if (compiled && testInputVal) {
                const m = testInputVal.match(compiled);
                matchCount = m ? m.length : 0;
                try {
                    finalHtml = testInputVal.replace(compiled, regexAsset.htmlContent);
                } catch (e) {
                    finalHtml = `<div style="color:#e74c3c;padding:12px;">正则替换错误: ${e.message}</div>`;
                }
            } else {
                finalHtml = regexAsset.htmlContent;
            }

            const badge = $('#wl_preview_match_badge');
            if (matchCount > 0) {
                badge.attr('class', 'regex-test-match-badge success').html(`<i class="fa-solid fa-check"></i> 命中 ${matchCount} 处`);
            } else if (testInputVal.trim().length > 0) {
                badge.attr('class', 'regex-test-match-badge warn').html(`<i class="fa-solid fa-circle-exclamation"></i> 未命中`);
            } else {
                badge.attr('class', 'regex-test-match-badge').text('直接展示');
            }
        } else {
            inDrawerRegexMeta = null;
            $('#wl_preview_top_bar').hide();
            $('#wl_preview_regex_test_bar').hide();
            finalHtml = (currentSelectedFile === currentSelectedFile)
                ? $('#worldlore_file_editor').val()
                : readFile(currentSelectedFile) || '';
        }

        const iframe = document.getElementById('worldlore_in_drawer_iframe');
        if (iframe) {
            iframe.srcdoc = buildIframeDoc(finalHtml, false);
        }
    }

    toggleEditorPreviewMode = function(forcedState) {
        if (!currentSelectedFile) return;
        isEditorPreviewActive = (forcedState !== undefined) ? forcedState : !isEditorPreviewActive;

        if (isEditorPreviewActive) {
            // Strict isolation: Hide editor completely, show preview
            $('#worldlore_file_editor').addClass('displayNone').attr('style', 'display: none !important;');
            $('#worldlore_editor_preview_container')
                .removeClass('displayNone')
                .attr('style', 'display: flex !important; width: 100%; flex: 1; min-height: 460px; height: 100%; flex-direction: column; box-sizing: border-box;');
            $('#worldlore_preview_html_btn')
                .removeClass('fa-eye')
                .addClass('fa-code active')
                .attr('title', '返回代码编辑 (切换回文本框)');
            updateInDrawerPreview();
        } else {
            // Strict isolation: Hide preview completely, show editor
            $('#worldlore_editor_preview_container').addClass('displayNone').attr('style', 'display: none !important;');
            $('#worldlore_file_editor')
                .removeClass('displayNone')
                .attr('style', 'display: block !important;');
            $('#worldlore_preview_html_btn')
                .removeClass('fa-code active')
                .addClass('fa-eye')
                .attr('title', '前端预览 HTML / 正则渲染效果');
        }
    };

    // Bind preview toggle button in editor action bar
    $('#worldlore_preview_html_btn').on('click', () => {
        toggleEditorPreviewMode();
    });

    // Toggle test bar sliding
    $('#wl_preview_test_toggle_btn').on('click', () => {
        const testBar = $('#wl_preview_regex_test_bar');
        const isOpen = testBar.hasClass('open');
        if (isOpen) {
            testBar.removeClass('open');
            $('#wl_preview_test_toggle_btn').removeClass('active');
        } else {
            testBar.addClass('open');
            $('#wl_preview_test_toggle_btn').addClass('active');
        }
    });




    // Fill mock data
    $('#wl_preview_fill_mock_btn').on('click', () => {
        if (!inDrawerRegexMeta?.findRegex) return;
        const mock = generateMockTextFromRegex(inDrawerRegexMeta.findRegex);
        $('#wl_preview_test_input').val(mock);
        // Ensure test bar is open so user sees mock data
        const testBar = $('#wl_preview_regex_test_bar');
        if (!testBar.hasClass('open')) {
            testBar.addClass('open');
            $('#wl_preview_test_toggle_btn').addClass('active');
        }
        updateInDrawerPreview();
    });

    // Live update when typing in test input
    $('#wl_preview_test_input').on('input', () => {
        updateInDrawerPreview();
    });

        // --- QUICK TOOLBAR BUTTONS: PULL ASSETS & NEW TEMPLATE ---
    $('#worldlore_quick_pull_lorebook_btn').on('click', async () => {
        const overview = getLorebooksOverview();
        const boundPrimary = overview.characterBoundLorebooks[0];
        const boundExtra = overview.characterBoundLorebooks.slice(1);
        const chatBound = overview.chatBoundLorebooks || [];
        const globalActive = overview.globalActiveLorebooks || [];
        const allAvailable = overview.allAvailableLorebooksInST || [];

        const options = [];
        const added = new Set();

        if (boundPrimary) {
            options.push({ value: boundPrimary, label: `★ 角色主绑定: ${boundPrimary}` });
            added.add(boundPrimary);
        }
        for (const b of boundExtra) {
            if (!added.has(b)) {
                options.push({ value: b, label: `☆ 角色附加: ${b}` });
                added.add(b);
            }
        }
        for (const b of chatBound) {
            if (!added.has(b)) {
                options.push({ value: b, label: `💬 聊天绑定: ${b}` });
                added.add(b);
            }
        }
        for (const b of globalActive) {
            if (!added.has(b)) {
                options.push({ value: b, label: `🌐 全局常驻: ${b}` });
                added.add(b);
            }
        }
        for (const b of allAvailable) {
            if (!added.has(b)) {
                options.push({ value: b, label: `📖 ${b}` });
                added.add(b);
            }
        }

        if (options.length === 0) {
            toastr.warning('酒馆中暂无可用的世界书！');
            return;
        }

        const selectedBook = await showSelectModal({
            title: '拉取世界书到工坊',
            message: '选择要导入的世界书：',
            options,
            defaultVal: boundPrimary || options[0].value
        });

        if (!selectedBook) return;

        try {
            toastr.info(`正在将世界书《${selectedBook}》导入工作区...`);
            const res = await importLorebookToWorkspace({ bookName: selectedBook });
            toastr.success(`已成功导入世界书《${res.bookName}》！生成了 ${res.filesCount} 份独立条目草稿文件。`);
            refreshWorkspaceUI();
        } catch (e) {
            toastr.error(`拉取世界书失败: ${e.message}`);
        }
    });

    $('#worldlore_quick_pull_character_btn').on('click', async () => {
        const char = getCurrentCharacter();
        if (!char) {
            toastr.warning('当前未选中任何角色卡！');
            return;
        }
        try {
            const desc = char.description || char.data?.description || '';
            const safeName = String(char.name || 'character').replace(/[/\\:*?"<>|]/g, '_').trim();
            const targetFile = `character/${safeName}/description.md`;

            writeFile(targetFile, desc, 'overwrite');
            currentSelectedFile = targetFile;
            refreshWorkspaceUI();
            loadFileToEditor(targetFile);

            toastr.success(`已拉取角色 [${char.name}] 的 description 设定到 ${targetFile}！`);
        } catch (e) {
            toastr.error(`拉取角色设定失败: ${e.message}`);
        }
    });

    $('#worldlore_quick_pull_persona_btn').on('click', async () => {
        try {
            const persona = getCurrentPersona();
            const desc = persona?.description || '';
            const safeName = String(persona?.name || 'default_user').replace(/[/\\:*?"<>|]/g, '_').trim();
            const targetFile = `persona/${safeName}/description.md`;

            writeFile(targetFile, desc, 'overwrite');
            currentSelectedFile = targetFile;
            refreshWorkspaceUI();
            loadFileToEditor(targetFile);

            toastr.success(`已拉取用户 [${persona?.name || '当前用户'}] 的 description 设定到 ${targetFile}！`);
        } catch (e) {
            toastr.error(`拉取用户人设失败: ${e.message}`);
        }
    });

    $('#worldlore_quick_pull_regex_btn').on('click', async () => {
        const scripts = getRegexScripts('all');
        if (!scripts || scripts.length === 0) {
            toastr.warning('酒馆中当前未安装任何正则脚本！');
            return;
        }

        const options = scripts.map(s => {
            const scopeLabel = s.scope === 'character' ? '角色专属' : (s.scope === 'preset' ? '预设绑定' : '全局通用');
            return {
                value: s.scriptName,
                label: `${scopeLabel}: ${s.scriptName}`
            };
        });

        const scriptName = await showSelectModal({
            title: '拉取正则脚本到工坊',
            message: '从酒馆已安装的列表中选择要导入的脚本：',
            options,
            defaultVal: options[0]?.value || ''
        });

        if (!scriptName) return;

        const found = findRegexScript('all', scriptName.trim());
        if (!found) {
            toastr.error(`未在酒馆中找到名为 "${scriptName}" 的正则脚本！`);
            return;
        }

        const s = found.script;
        const safeName = String(s.scriptName || 'regex').replace(/[/\\:*?"<>|]/g, '_').trim();
        const folder = `regex/${safeName}`;

        const meta = {
            id: s.id,
            scriptName: s.scriptName,
            scope: found.scope,
            findRegex: s.findRegex || '',
            placement: Array.isArray(s.placement) ? s.placement : [1, 2],
            disabled: !!s.disabled,
            markdownOnly: !!s.markdownOnly,
            promptOnly: !!s.promptOnly,
            runOnEdit: !!s.runOnEdit,
            substituteRegex: s.substituteRegex ?? 0,
            trimStrings: s.trimStrings || []
        };

        writeFile(`${folder}/meta.json`, JSON.stringify(meta, null, 2), 'overwrite');
        writeFile(`${folder}/replace.html`, s.replaceString || '', 'overwrite');

        currentSelectedFile = `${folder}/replace.html`;
        refreshWorkspaceUI();
        loadFileToEditor(currentSelectedFile);

        toastr.success(`已成功将正则《${s.scriptName}》拆解导入到 ${folder}/！`);
    });

    $('#worldlore_quick_new_template_btn').on('click', async () => {
        const templateType = await showSelectModal({
            title: '新建标准草稿模板',
            message: '选择要创建的资产模板类型：',
            options: [
                { value: 'new_lorebook_project', label: '📚 新建世界书工程' },
                { value: 'new_lorebook_entry', label: '📄 新建世界书条目模板' },
                { value: 'new_regex_script', label: '🎨 新建前端美化正则模板' }
            ],
            defaultVal: 'new_lorebook_project'
        });

        if (!templateType) return;

        if (templateType === 'new_lorebook_project') {
            const char = getCurrentCharacter();
            const defaultName = char ? `${char.name}_设定集` : '新世界书';
            const bookNameInput = await Popup.show.input('新建世界书工程', '请输入新世界书名称：', defaultName);
            if (!bookNameInput || !bookNameInput.trim()) return;

            const safeBookName = bookNameInput.replace(/[/\\:*?"<>|]/g, '_').trim();
            const folder = `lorebooks/${safeBookName}`;

            const meta = {
                bookName: safeBookName,
                scan_depth: 2,
                token_budget: 2048,
                recursive: false,
                createdAt: new Date().toISOString()
            };
            writeFile(`${folder}/meta.json`, JSON.stringify(meta, null, 2), 'overwrite');

            const sampleEntryContent = formatFrontmatter({
                comment: '世界观概况',
                keys: ['世界观', '背景', '大陆'],
                secondary_keys: [],
                constant: true,
                enabled: true,
                order: 100,
                position: 0,
                depth: 4
            }, '# 世界观总览\n\n在此输入世界书核心世界观、阵营、地理或历史设定...\n');

            const entryPath = `${folder}/世界观概况.md`;
            writeFile(entryPath, sampleEntryContent, 'overwrite');

            currentSelectedFile = entryPath;
            refreshWorkspaceUI();
            loadFileToEditor(entryPath);
            toastr.success(`已创建世界书工程: ${folder}/`);
        } else if (templateType === 'new_lorebook_entry') {
            const name = await Popup.show.input('新建世界书条目草稿', '输入条目相对路径：', 'lorebooks/default/new_entry.md');
            if (!name || !name.trim()) return;
            const path = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
            const defaultComment = path.split('/').pop().replace(/\.md$/i, '');
            const templateContent = formatFrontmatter({
                comment: defaultComment,
                keys: ['触发词1', '触发词2'],
                secondary_keys: [],
                constant: false,
                enabled: true,
                order: 100,
                position: 0,
                depth: 4
            }, `# ${defaultComment}\n\n在此输入条目设定正文...\n`);
            writeFile(path, templateContent, 'overwrite');
            currentSelectedFile = path;
            refreshWorkspaceUI();
            loadFileToEditor(path);
            toastr.success(`已创建世界书条目模板: ${path}`);
        } else if (templateType === 'new_regex_script') {
            const name = await Popup.show.input('新建前端正则美化模板', '输入正则脚本名称：', '新美化面板');
            if (!name || !name.trim()) return;
            const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
            const folder = `regex/${safeName}`;
            const meta = {
                scriptName: name.trim(),
                scope: 'character',
                findRegex: '<status>([\\s\\S]*?)</status>',
                placement: [1, 2],
                disabled: false,
                substituteRegex: 0
            };
            const defaultHtml = `<div class="status-panel">\n  <div class="header">状态栏</div>\n  <div class="content">$1</div>\n</div>\n<style>\n.status-panel {\n  background: rgba(0, 0, 0, 0.45);\n  border: 1px solid #38ef7d;\n  border-radius: 8px;\n  padding: 10px;\n  color: #fff;\n}\n</style>`;
            writeFile(`${folder}/meta.json`, JSON.stringify(meta, null, 2), 'overwrite');
            writeFile(`${folder}/replace.html`, defaultHtml, 'overwrite');
            currentSelectedFile = `${folder}/replace.html`;
            refreshWorkspaceUI();
            loadFileToEditor(currentSelectedFile);
            toastr.success(`已创建前端正则模板: ${folder}/`);
        }
    });

    $('#worldlore_file_search_input').on('input', function () {
        const q = $(this).val().toLowerCase();
        renderFileList(q);
    });

    $('#worldlore_copy_prompt_btn').on('click', () => {
        const text = getToolDocumentationPrompt(true);
        if (!text) {
            toastr.warning('当前未生成提示词（请检查是否勾选了工具或启用了扩展）');
            return;
        }
        navigator.clipboard.writeText(text).then(() => {
            const mode = getSettings().toolMode || 'native';
            toastr.success(`已复制${mode === 'native' ? '原生模式' : '文本模式'}提示词到剪贴板！`);
        });
    });

    $('#worldlore_copy_macro_btn').on('click', () => {
        navigator.clipboard.writeText('{{worldlore_tools}}').then(() => {
            toastr.success('已复制宏标记 {{worldlore_tools}} 到剪贴板！');
        });
    });

    // --- TOOL MODE TOGGLE & TOOLS CHECKBOX MANAGER ---
    const renderModeLabel = () => {
        const mode = getSettings().toolMode || 'native';
        const isNative = mode === 'native';
        $('#worldlore_mode_native_btn').toggleClass('active', isNative);
        $('#worldlore_mode_text_btn').toggleClass('active', !isNative);
        $('#worldlore_mode_label').text(isNative
            ? '原生模式：工具走原生 API 协议，下方可自定义勾选启用哪些工具'
            : '文本模式：<agent_action> 标签模式，走预设宏文本注入');

        // 原生模式与文本模式均显示提示词宏区域
        $('#worldlore_copy_prompt_section').show();
        if (isNative) {
            $('#worldlore_macro_section_title').text('原生模式预设宏与提示词');
            $('#worldlore_macro_section_desc').html('已自动注册酒馆全局宏 <code>{{worldlore_tools}}</code>，可直接在预设任意位置插入！原生模式下将注入原生 Function Calling 说明提示词。');
            $('#worldlore_copy_prompt_btn').attr('title', '一键复制原生模式提示词');
        } else {
            $('#worldlore_macro_section_title').text('文本模式预设宏与提示词');
            $('#worldlore_macro_section_desc').html('已自动注册酒馆全局宏 <code>{{worldlore_tools}}</code>，可直接在预设任意位置插入！发送时将根据上方勾选的工具实时动态注入。');
            $('#worldlore_copy_prompt_btn').attr('title', '一键复制当前勾选工具生成的文本模式完整提示词');
        }
    };

    // --- PRESET IMPORT BUTTON ---
    $('#worldlore_import_preset_btn').on('click', async function () {
        const btn = $(this);
        if (btn.hasClass('loading')) return;

        btn.addClass('loading').prop('disabled', true);
        const originalHtml = btn.html();
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i> <span>正在导入...</span>');

        try {
            await importBundledPresetToSillyTavern();
        } catch (e) {
            console.error('[Worldlore Agent] Error importing preset:', e);
            toastr.error(`导入预设失败: ${e.message || e}`);
        } finally {
            btn.removeClass('loading').prop('disabled', false).html(originalHtml);
        }
    });

    $('#worldlore_mode_native_btn').on('click', () => {
        setToolMode('native');
        renderModeLabel();
        renderToolsManagerList();
        toastr.success('已切换至原生 Function Calling 模式');
    });

    $('#worldlore_mode_text_btn').on('click', () => {
        setToolMode('text');
        renderModeLabel();
        renderToolsManagerList();
        toastr.success('已切换至文本标签模式');
    });

    $('#worldlore_select_all_tools_btn').on('click', () => {
        for (const g of TOOL_GROUPS) {
            for (const t of g.tools) {
                setToolEnabled(t.name, true);
            }
        }
        renderToolsManagerList();
        toastr.success('已启用全部 AI 工具');
    });

    $('#worldlore_deselect_all_tools_btn').on('click', () => {
        for (const g of TOOL_GROUPS) {
            for (const t of g.tools) {
                setToolEnabled(t.name, false);
            }
        }
        renderToolsManagerList();
        toastr.warning('已禁用全部 AI 工具');
    });

    // Init label on load
    renderModeLabel();
    renderToolsManagerList();

    $('#worldlore_apply_all_btn').on('click', async () => {
        const entries = getStagingEntries();
        if (entries.length === 0) return toastr.info('暂存区没有待同步的条目');
        const conf = await Popup.show.confirm('一键同步', `确定将暂存区的 ${entries.length} 个条目全部应用并写入到 ST 世界书/角色卡/Persona 吗？`);
        if (conf) {
            const results = await applyAllStaging();
            toastr.success(`已成功同步 ${results.filter(r => r.success).length} 项设定！`);
            renderStagingList();
            updateStagingCounter();
        }
    });

    $('#worldlore_clear_staging_btn').on('click', async () => {
        const conf = await Popup.show.confirm('清空暂存区', '确定要放弃并清空暂存区所有待同步内容吗？');
        if (conf) {
            clearStaging();
            toastr.info('暂存区已清空');
            renderStagingList();
            updateStagingCounter();
        }
    });

    $('#worldlore_clear_history_btn').on('click', async () => {
        const conf = await Popup.show.confirm('清空日志', '确定要清空所有历史操作记录吗？');
        if (conf) {
            clearHistory();
            toastr.info('历史日志已清空');
            renderHistoryList();
        }
    });

    window.addEventListener('worldlore_staging_updated', () => {
        renderStagingList();
        updateStagingCounter();
    });

    window.addEventListener('worldlore_history_updated', () => {
        renderHistoryList();
    });
}

export function toggleDrawer(forceState) {
    const now = Date.now();
    if (now - lastToggleTime < 180) return;
    lastToggleTime = now;

    const drawer = document.getElementById('worldlore_agent_drawer');
    const backdrop = document.getElementById('worldlore_drawer_backdrop');
    if (!drawer) return;

    const isOpen = typeof forceState === 'boolean' ? forceState : !drawer.classList.contains('open');

    if (isOpen) {
        drawer.classList.add('open');
        if (backdrop) backdrop.classList.add('active');
        requestAnimationFrame(() => {
            refreshWorkspaceUI();
            renderStagingList();
            renderHistoryList();
            updateStats();
        });
    } else {
        drawer.classList.remove('open');
        if (backdrop) backdrop.classList.remove('active');
    }
}

const TOOL_GROUPS = [
    {
        title: '世界书与全局知识库',
        icon: 'fa-book-atlas',
        tools: [
            { name: 'st_import_lorebook_to_workspace', label: '导入世界书到工坊' },
            { name: 'stage_lorebook_entry', label: '发布/删除世界书条目' },
            { name: 'st_create_and_bind_lorebook', label: '新建世界书并绑定角色卡' },
            { name: 'st_delete_lorebook', label: '彻底删除世界书并解除绑定' },
            { name: 'st_read_lorebook', label: '读取世界书条目列表' },
            { name: 'st_get_lorebooks_overview', label: '查看酒馆世界书全景概况' },
        ]
    },
    {
        title: '角色卡与用户人设设定',
        icon: 'fa-user-tag',
        tools: [
            { name: 'st_import_character_to_workspace', label: '导入角色卡设定到工作区' },
            { name: 'stage_character_field', label: '发布角色卡字段修改' },
            { name: 'st_get_character', label: '读取当前角色卡全部详情' },
            { name: 'st_import_persona_to_workspace', label: '导入用户人设到工作区' },
            { name: 'stage_persona_field', label: '发布用户人设描述修改' },
            { name: 'st_get_persona', label: '读取当前用户 Persona 设定' },
        ]
    },
    {
        title: '前端美化与正则脚本',
        icon: 'fa-code',
        tools: [
            { name: 'st_import_regex_to_workspace', label: '导入正则拆解为 replace.html' },
            { name: 'st_install_regex_from_file', label: '从工作区安装部署正则脚本' },
            { name: 'st_delete_regex_script', label: '删除已安装的正则脚本' },
            { name: 'st_list_regex_scripts', label: '查看酒馆已安装正则列表' },
            { name: 'st_test_regex_script', label: '沙盒自测正则替换效果' },
        ]
    },
    {
        title: '工作区草稿与文件操作',
        icon: 'fa-folder-tree',
        tools: [
            { name: 'workspace_patch', label: '精准局部差量修改草稿' },
            { name: 'workspace_write', label: '全量写入草稿文件' },
            { name: 'workspace_rename', label: '重命名草稿文件' },
            { name: 'workspace_rename_project', label: '重命名工作区项目' },
            { name: 'workspace_read', label: '读取工作区草稿文件' },
            { name: 'workspace_delete', label: '删除工作区草稿文件' },
            { name: 'workspace_list', label: '列出工作区文件列表' },
            { name: 'workspace_search', label: '在工作区搜索设定关键词' },
        ]
    }
];

export function renderToolsManagerList() {
    const container = $('#worldlore_tools_checkbox_list');
    if (!container.length) return;
    container.empty();

    for (const group of TOOL_GROUPS) {
        const card = $(`
            <div class="tool-group-card">
                <div class="tool-group-title">
                    <i class="fa-solid ${group.icon}"></i>
                    <span>${group.title}</span>
                </div>
                <div class="tool-group-items"></div>
            </div>
        `);
        const itemsContainer = card.find('.tool-group-items');

        for (const item of group.tools) {
            const enabled = isToolEnabled(item.name);
            const toolDef = TOOL_DEFINITIONS.find(t => t.name === item.name);
            const fullDesc = toolDef?.description || item.label;
            const toolRow = $(`
                <label class="tool-checkbox-item" title="${fullDesc}">
                    <input type="checkbox" data-tool="${item.name}" ${enabled ? 'checked' : ''} />
                    <div class="tool-item-info">
                        <span class="tool-item-name">${item.name}</span>
                        <span class="tool-item-desc">${item.label}</span>
                    </div>
                </label>
            `);

            toolRow.find('input').on('change', function () {
                const isChecked = $(this).is(':checked');
                setToolEnabled(item.name, isChecked);
                toastr.info(`已${isChecked ? '启用' : '禁用'}工具: ${item.name}`);
            });

            itemsContainer.append(toolRow);
        }

        container.append(card);
    }
}

function switchTab(tabName) {
    $('.worldlore-tab-btn').removeClass('active');
    $(`.worldlore-tab-btn[data-tab="${tabName}"]`).addClass('active');
    $('.worldlore-tab-pane').removeClass('active');
    $(`#worldlore_pane_${tabName}`).addClass('active');

    requestAnimationFrame(() => {
        if (tabName === 'workspace') refreshWorkspaceUI();
        if (tabName === 'staging') renderStagingList();
        if (tabName === 'history') renderHistoryList();
        if (tabName === 'guide') {
            updateStats();
            renderToolsManagerList();
        }
    });
}

export function refreshWorkspaceUI() {
    const projects = getProjects();
    const activeProject = getActiveProjectName();

    $('#worldlore_cur_proj_name').text(activeProject);

    const select = $('#worldlore_project_select');
    select.empty();
    for (const p of projects) {
        const opt = $('<option></option>').val(p).text(p);
        if (p === activeProject) opt.prop('selected', true);
        select.append(opt);
    }

    renderFileList($('#worldlore_file_search_input').val());

    const files = listFiles();
    if (!currentSelectedFile && files.length > 0) {
        currentSelectedFile = files[0].path;
    }
    if (currentSelectedFile) {
        loadFileToEditor(currentSelectedFile);
    }
}

export async function pushDraftFileToStaging(path) {
    if (!path) return;
    const content = readFile(path);
    if (content === null) {
        toastr.error(`未找到草稿文件: ${path}`);
        return;
    }

    try {
        if (path.startsWith('lorebooks/')) {
            const parts = path.split('/');
            const bookName = parts[1] || 'default';
            if (parts.length < 3 || path.endsWith('/meta.json')) {
                toastr.warning('meta.json 为全书全局配置，请直接推送具体条目的 .md 草稿');
                return;
            }
            const parsed = parseFrontmatter(content);
            const fmData = parsed.data || {};
            const entryContent = parsed.content || '';
            const comment = fmData.comment || parts[parts.length - 1].replace(/\.md$/i, '');

            addStagingEntry({
                type: 'lorebook',
                action: 'update',
                target: bookName,
                data: {
                    action: 'update',
                    comment: comment,
                    keys: fmData.keys || [],
                    secondary_keys: fmData.secondary_keys || [],
                    content: entryContent,
                    constant: fmData.constant !== undefined ? fmData.constant : true,
                    enabled: fmData.enabled !== undefined ? fmData.enabled : true,
                    disable: fmData.enabled === false,
                    order: fmData.order ?? 100,
                    position: fmData.position ?? 0,
                    depth: fmData.depth ?? 4,
                },
                summary: `[世界书: ${bookName}] 推送条目 "${comment}" (源于草稿: ${path})`
            });

            toastr.success(`已推送到审核区: 《${comment}》`);
            updateStagingCounter();
        } else if (path.startsWith('character/')) {
            const parts = path.split('/');
            const fileName = parts[parts.length - 1] || '';
            const field = fileName.replace(/\.md$/i, '');
            const char = getCurrentCharacter();
            const charName = char ? char.name : (parts[1] || 'Current Character');

            addStagingEntry({
                type: 'character',
                action: 'update',
                target: charName,
                data: {
                    [field]: content,
                    mode: 'replace'
                },
                summary: `[角色卡: ${charName}] 更新字段 "${field}" (源于: ${path})`
            });

            toastr.success(`已推送到审核区: 角色字段 [${field}]`);
            updateStagingCounter();
        } else if (path.startsWith('persona/')) {
            const persona = getCurrentPersona();
            const personaName = persona ? persona.name : 'Current User';

            addStagingEntry({
                type: 'persona',
                action: 'update',
                target: personaName,
                data: {
                    description: content,
                    mode: 'replace'
                },
                summary: `[用户设定: ${personaName}] 更新人设描述 (源于: ${path})`
            });

            toastr.success(`已推送到审核区: 用户人设描述`);
            updateStagingCounter();
        } else if (path.startsWith('regex/')) {
            const parts = path.split('/');
            const folder = parts.slice(0, 2).join('/');
            const metaPath = `${folder}/meta.json`;
            const htmlPath = `${folder}/replace.html`;

            const metaText = readFile(metaPath);
            const htmlContent = readFile(htmlPath);

            if (metaText === null || htmlContent === null) {
                toastr.error(`正则文件夹必须同时包含 replace.html 与 meta.json！`);
                return;
            }

            let meta = {};
            try { meta = JSON.parse(metaText); } catch (e) {
                toastr.error(`meta.json 解析失败: ${e.message}`);
                return;
            }

            const scriptName = meta.scriptName || folder.split('/').pop() || '未命名正则';
            const targetScope = meta.scope || 'character';
            const existing = findRegexScript(targetScope, scriptName);
            const isUpdate = !!existing;

            const completeScript = {
                id: meta.id,
                scriptName,
                findRegex: meta.findRegex || '',
                replaceString: htmlContent,
                trimStrings: Array.isArray(meta.trimStrings) ? meta.trimStrings : [],
                placement: Array.isArray(meta.placement) && meta.placement.length > 0 ? meta.placement : [1, 2],
                disabled: meta.disabled === true,
                markdownOnly: meta.markdownOnly === true,
                promptOnly: meta.promptOnly === true,
                runOnEdit: meta.runOnEdit === true,
                substituteRegex: Number(meta.substituteRegex ?? 0),
                minDepth: meta.minDepth !== undefined && meta.minDepth !== null ? Number(meta.minDepth) : null,
                maxDepth: meta.maxDepth !== undefined && meta.maxDepth !== null ? Number(meta.maxDepth) : null,
            };

            addStagingEntry({
                type: 'regex',
                action: isUpdate ? 'update' : 'add',
                target: `${targetScope}:${scriptName}`,
                data: {
                    scope: targetScope,
                    scriptName,
                    script: completeScript,
                    from_folder: folder,
                    replace_existing: true,
                    beforeScript: existing ? existing.script : null
                },
                summary: `[正则脚本: ${targetScope}] ${isUpdate ? '更新' : '新增'} "${scriptName}" (源于: ${folder})`
            });

            toastr.success(`已推送到审核区: 正则《${scriptName}》`);
            updateStagingCounter();
        } else {
            toastr.info(`普通草稿文件 [${path}]，已保存在工作区，可供提示词引用。`);
        }
    } catch (e) {
        console.error('[Worldlore Agent] pushDraftFileToStaging error:', e);
        toastr.error(`推送失败: ${e.message}`);
    }
}

export async function diffDraftFileWithST(path) {
    if (!path) return;
    const content = readFile(path);
    if (content === null) {
        toastr.error(`未找到草稿文件: ${path}`);
        return;
    }

    try {
        if (path.startsWith('lorebooks/')) {
            const parts = path.split('/');
            const bookName = parts[1] || '';
            const parsed = parseFrontmatter(content);
            const comment = parsed.data?.comment || parts[parts.length - 1].replace(/\.md$/i, '');
            const newText = parsed.content || '';

            const data = await loadWorldInfo(bookName);
            let oldText = '(酒馆中无此条目 / 尚未在线建立)';
            if (data && data.entries) {
                const found = Object.values(data.entries).find(e => e.comment && e.comment.trim().toLowerCase() === comment.trim().toLowerCase());
                if (found && found.content) oldText = found.content;
            }
            showDiffModal(`对比世界书条目: 《${comment}》 (${bookName})`, oldText, newText);
        } else if (path.startsWith('character/')) {
            const parts = path.split('/');
            const field = parts[parts.length - 1].replace(/\.md$/i, '');
            const char = getCurrentCharacter();
            const oldText = char ? (char[field] || char.data?.[field] || '') : '(未选定角色卡)';
            showDiffModal(`对比角色卡字段: [${field}]`, oldText, content);
        } else if (path.startsWith('persona/')) {
            const persona = getCurrentPersona();
            const oldText = persona?.description || '';
            showDiffModal(`对比用户人设描述`, oldText, content);
        } else if (path.startsWith('regex/')) {
            const parts = path.split('/');
            const folder = parts.slice(0, 2).join('/');
            const metaText = readFile(`${folder}/meta.json`);
            const htmlContent = readFile(`${folder}/replace.html`) || '';
            let scriptName = folder.split('/').pop();
            let scope = 'all';
            if (metaText) {
                try {
                    const meta = JSON.parse(metaText);
                    if (meta.scriptName) scriptName = meta.scriptName;
                    if (meta.scope) scope = meta.scope;
                } catch (_) {}
            }
            const found = findRegexScript(scope, scriptName);
            const oldText = found?.script?.replaceString || '(酒馆中尚未安装此正则)';
            showDiffModal(`对比正则前端代码: 《${scriptName}》`, oldText, htmlContent);
        } else {
            toastr.info('该草稿为工作区通用文件，暂无对应的酒馆线上实体');
        }
    } catch (e) {
        console.error('[Worldlore Agent] diffDraftFileWithST error:', e);
        toastr.error(`对比失败: ${e.message}`);
    }
}

function buildFileTree(files) {
    const root = {
        name: '',
        path: '',
        folders: new Map(),
        files: []
    };

    for (const file of files) {
        const parts = file.path.split('/');
        let currentFolder = root;
        let currentPath = '';

        for (let i = 0; i < parts.length - 1; i++) {
            const folderName = parts[i];
            currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
            if (!currentFolder.folders.has(folderName)) {
                currentFolder.folders.set(folderName, {
                    name: folderName,
                    path: currentPath,
                    folders: new Map(),
                    files: []
                });
            }
            currentFolder = currentFolder.folders.get(folderName);
        }

        const fileName = parts[parts.length - 1];
        currentFolder.files.push({
            ...file,
            name: fileName,
            fullPath: file.path
        });
    }

    return root;
}

function countFilesInTree(node) {
    let count = node.files.length;
    for (const sub of node.folders.values()) {
        count += countFilesInTree(sub);
    }
    return count;
}

function ensureFolderExpanded(filePath) {
    if (!filePath) return;
    const parts = filePath.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        expandedFolders.add(cur);
    }
}

function renderFolderFilterPills(allFiles) {
    const pillsContainer = $('#worldlore_folder_filter_pills');
    if (!pillsContainer.length) return;
    pillsContainer.empty();

    if (!allFiles || allFiles.length === 0) {
        pillsContainer.hide();
        return;
    }

    const tree = buildFileTree(allFiles);
    const topFolders = Array.from(tree.folders.keys()).sort();
    const rootFilesCount = tree.files.length;

    if (topFolders.length === 0) {
        pillsContainer.hide();
        return;
    }
    pillsContainer.show();

    // 1. "全部" Pill
    const isAllActive = currentFolderFilter === null;
    const allPill = $(`
        <div class="worldlore-filter-pill ${isAllActive ? 'active' : ''}">
            <i class="fa-solid fa-layer-group"></i>
            <span>全部</span>
            <span class="pill-count">${allFiles.length}</span>
        </div>
    `);
    allPill.on('click', () => {
        currentFolderFilter = null;
        renderFileList($('#worldlore_file_search_input').val());
    });
    pillsContainer.append(allPill);

    // 2. Folder Pills
    for (const folderName of topFolders) {
        const folderNode = tree.folders.get(folderName);
        const count = countFilesInTree(folderNode);
        const isAct = currentFolderFilter === folderName;
        const pill = $(`
            <div class="worldlore-filter-pill ${isAct ? 'active' : ''}">
                <i class="fa-solid fa-folder"></i>
                <span class="worldlore-nowrap-text">${escapeHtml(folderName)}</span>
                <span class="pill-count">${count}</span>
            </div>
        `);
        pill.on('click', () => {
            currentFolderFilter = isAct ? null : folderName;
            if (currentFolderFilter) {
                expandedFolders.add(folderName);
            }
            renderFileList($('#worldlore_file_search_input').val());
        });
        pillsContainer.append(pill);
    }

    // 3. Root Files Pill if any
    if (rootFilesCount > 0) {
        const isAct = currentFolderFilter === '__root__';
        const rootPill = $(`
            <div class="worldlore-filter-pill ${isAct ? 'active' : ''}">
                <i class="fa-solid fa-file"></i>
                <span>根目录</span>
                <span class="pill-count">${rootFilesCount}</span>
            </div>
        `);
        rootPill.on('click', () => {
            currentFolderFilter = isAct ? null : '__root__';
            renderFileList($('#worldlore_file_search_input').val());
        });
        pillsContainer.append(rootPill);
    }
}

function renderFileList(query = '') {
    const container = $('#worldlore_file_list');
    container.empty();
    const allFiles = listFiles();

    // Render filter pills
    renderFolderFilterPills(allFiles);

    // Filter by search query if any
    let files = allFiles;
    const lowerQuery = (query || '').toLowerCase().trim();
    if (lowerQuery) {
        files = files.filter(f => f.path.toLowerCase().includes(lowerQuery));
    }

    // Filter by top pill if selected
    if (currentFolderFilter === '__root__') {
        files = files.filter(f => !f.path.includes('/'));
    } else if (currentFolderFilter) {
        files = files.filter(f => f.path.startsWith(currentFolderFilter + '/') || f.path === currentFolderFilter);
    }

    if (files.length === 0) {
        container.html('<div class="worldlore-empty-hint"><i class="fa-solid fa-folder-open"></i><br/><span style="font-size:12px;">无匹配草稿</span></div>');
        return;
    }

    const tree = buildFileTree(files);

    // If first load or searching, auto-expand relevant folders
    if (!folderTreeInitialized || lowerQuery) {
        for (const [name, folderNode] of tree.folders) {
            expandedFolders.add(folderNode.path);
        }
        if (currentSelectedFile) {
            ensureFolderExpanded(currentSelectedFile);
        }
        if (!lowerQuery) {
            folderTreeInitialized = true;
        }
    }

    // Render tree nodes recursively
    function renderTreeNode(node, targetEl, depth = 0) {
        // Render subfolders first
        const sortedFolderNames = Array.from(node.folders.keys()).sort();
        for (const fName of sortedFolderNames) {
            const subNode = node.folders.get(fName);
            const totalCount = countFilesInTree(subNode);
            const isExpanded = expandedFolders.has(subNode.path);

            const folderGroup = $(`
                <div class="worldlore-folder-group" data-folder-path="${escapeHtml(subNode.path)}">
                    <div class="worldlore-folder-header">
                        <i class="fa-solid fa-chevron-right folder-chevron ${isExpanded ? 'expanded' : ''}"></i>
                        <div class="folder-pill-badge" title="点击展开/收起文件夹: ${escapeHtml(subNode.path)}">
                            <i class="fa-solid ${isExpanded ? 'fa-folder-open' : 'fa-folder'} folder-icon"></i>
                            <span class="folder-title">${escapeHtml(subNode.name)}</span>
                            <span class="folder-badge-count">${totalCount}</span>
                        </div>
                    </div>
                    <div class="worldlore-folder-children" style="${isExpanded ? '' : 'display:none;'}"></div>
                </div>
            `);

            // Header toggle click
            folderGroup.find('.worldlore-folder-header').on('click', (e) => {
                e.stopPropagation();
                const childrenEl = folderGroup.find('.worldlore-folder-children');
                const chevron = folderGroup.find('.folder-chevron');
                const icon = folderGroup.find('.folder-icon');

                if (expandedFolders.has(subNode.path)) {
                    expandedFolders.delete(subNode.path);
                    childrenEl.slideUp(140);
                    chevron.removeClass('expanded');
                    icon.removeClass('fa-folder-open').addClass('fa-folder');
                } else {
                    expandedFolders.add(subNode.path);
                    childrenEl.slideDown(140);
                    chevron.addClass('expanded');
                    icon.removeClass('fa-folder').addClass('fa-folder-open');
                }
            });

            const childrenContainer = folderGroup.find('.worldlore-folder-children');
            renderTreeNode(subNode, childrenContainer, depth + 1);
            targetEl.append(folderGroup);
        }

        // Render files in this node
        const sortedFiles = node.files.sort((a, b) => a.name.localeCompare(b.name));
        for (const file of sortedFiles) {
            const canPush = (file.fullPath.startsWith('lorebooks/') || file.fullPath.startsWith('character/') || file.fullPath.startsWith('persona/') || file.fullPath.startsWith('regex/')) && !file.fullPath.endsWith('/meta.json') && file.fullPath !== 'meta.json';

            const canPreview = file.fullPath.endsWith('.html') || file.fullPath.endsWith('.htm') || file.fullPath.startsWith('regex/');
            const actionButtonsHtml = `
                <div class="file-item-actions">
                    ${canPush ? `
                        <button class="file-action-btn quick-push-file-btn fa-solid fa-rocket" title="一键推送到酒馆待确认审核区"></button>
                        <button class="file-action-btn quick-diff-file-btn fa-solid fa-code-compare" title="对比草稿与酒馆线上版本 (Diff)"></button>
                    ` : ''}
                    ${canPreview ? `
                        <button class="file-action-btn quick-preview-file-btn fa-solid fa-eye" title="前端预览 HTML / 正则渲染效果"></button>
                    ` : ''}
                    <button class="file-action-btn quick-rename-file-btn fa-solid fa-pen-to-square" title="重命名草稿"></button>
                </div>
            `;

            const item = $(`
                <div class="worldlore-file-item ${currentSelectedFile === file.fullPath ? 'active' : ''}" data-file-path="${escapeHtml(file.fullPath)}">
                    <i class="fa-solid fa-file-lines file-icon"></i>
                    <span class="file-path file-leaf-name" title="${escapeHtml(file.fullPath)}">${escapeHtml(file.name)}</span>
                    <span class="file-size">${file.length}b</span>
                    ${actionButtonsHtml}
                </div>
            `);

            item.on('click', () => {
                currentSelectedFile = file.fullPath;
                $('.worldlore-file-item').removeClass('active');
                item.addClass('active');
                loadFileToEditor(file.fullPath);
            });

            item.find('.quick-rename-file-btn').on('click', (e) => {
                e.stopPropagation();
                promptRenameFile(file.fullPath);
            });

            if (canPreview) {
                item.find('.quick-preview-file-btn').on('click', (e) => {
                    e.stopPropagation();
                    loadFileToEditor(file.fullPath);
                    if (typeof toggleEditorPreviewMode === 'function') toggleEditorPreviewMode(true);
                });
            }

            if (canPush) {
                item.find('.quick-push-file-btn').on('click', (e) => {
                    e.stopPropagation();
                    pushDraftFileToStaging(file.fullPath);
                });

                item.find('.quick-diff-file-btn').on('click', (e) => {
                    e.stopPropagation();
                    diffDraftFileWithST(file.fullPath);
                });
            }

            targetEl.append(item);
        }
    }

    renderTreeNode(tree, container, 0);
}

function loadFileToEditor(path) {
    currentSelectedFile = path;
    ensureFolderExpanded(path);
    if (typeof toggleEditorPreviewMode === 'function') toggleEditorPreviewMode(false);
    const content = readFile(path);
    if (content !== null) {
        $('#worldlore_editor_filename').text(path);
        $('#worldlore_cur_file_name').text(path);
        $('#worldlore_file_editor').val(content);
        $('#worldlore_save_file_btn, #worldlore_delete_file_btn, #worldlore_rename_file_btn, #worldlore_push_editor_file_btn, #worldlore_diff_editor_file_btn, #worldlore_preview_html_btn').show();
    }
}

export function renderStagingList() {
    const entries = getStagingEntries();
    const container = $('#worldlore_staging_list');
    container.empty();

    $('#worldlore_staging_count_text').text(`${entries.length} 项待确认变更`);

    if (entries.length === 0) {
        container.html('<div class="worldlore-empty-hint"><i class="fa-solid fa-inbox"></i><br/>暂存区为空</div>');
        return;
    }

    for (const item of entries) {
        const typeIcons = {
            lorebook: 'fa-book-atlas',
            character: 'fa-user-tag',
            persona: 'fa-user-pen',
            workspace: 'fa-file-signature',
            regex: 'fa-code'
        };

        const actionBadges = {
            add: '<span class="staged-badge add"><i class="fa-solid fa-plus"></i></span>',
            update: '<span class="staged-badge update"><i class="fa-solid fa-pen"></i></span>',
            delete: '<span class="staged-badge delete"><i class="fa-solid fa-trash"></i></span>',
            write: '<span class="staged-badge write"><i class="fa-solid fa-file-pen"></i></span>'
        };

        const card = $(`
            <div class="worldlore-staging-card" data-stage-id="${item.id}">
                <div class="card-header">
                    <div class="card-title-wrapper">
                        <i class="fa-solid ${typeIcons[item.type] || 'fa-bolt'} card-type-icon"></i>
                        <span class="card-summary-text" title="${escapeHtml(item.summary || item.target)}">${escapeHtml(item.summary || item.target)}</span>
                        ${actionBadges[item.action] || ''}
                    </div>
                    <div class="card-actions">
                        <button class="diff-btn menu_button fa-solid fa-code-compare" title="查看修改对比 (Diff)"></button>
                        <button class="apply-btn menu_button primary fa-solid fa-check" title="应用此项"></button>
                        <button class="discard-btn menu_button fa-solid fa-xmark" title="丢弃此项"></button>
                    </div>
                </div>
                <div class="card-body">
                    ${renderStagingDataDetails(item)}
                </div>
            </div>
        `);

        // Apply
        card.find('.apply-btn').on('click', async () => {
            try {
                await applyStagingEntry(item.id);
                toastr.success(`已应用: ${item.summary || item.target}`);
                renderStagingList();
                updateStagingCounter();
            } catch (e) {
                toastr.error(`应用失败: ${e.message}`);
            }
        });

        // Discard
        card.find('.discard-btn').on('click', () => {
            removeStagingEntry(item.id);
            renderStagingList();
            updateStagingCounter();
        });

        // View Diff
        card.find('.diff-btn').on('click', () => {
            if (item.type === 'lorebook') {
                const res = readLorebookEntriesScoped('active');
                const oldEntry = (res?.entries || []).find(e => (!item.data.book || e.book === item.data.book) && e.comment === item.data.comment);
                const oldText = oldEntry ? (oldEntry.content || '') : '(库中暂无此条目，本次为新增条目)';
                const newText = item.data.content || (item.data.from_file ? readFile(item.data.from_file) : '') || '';
                showDiffModal(`世界书条目对比: ${item.data.comment || item.target}`, oldText, newText);
            } else if (item.type === 'character') {
                const char = getCurrentCharacter();
                const fieldKey = Object.keys(item.data || {})[0] || 'description';
                const oldText = char ? (char[fieldKey] || '(原设定为空)') : '(未选定角色)';
                const newText = String(item.data[fieldKey] || '');
                showDiffModal(`角色设定对比: ${char?.name || '角色'}.${fieldKey}`, oldText, newText);
            } else if (item.type === 'persona') {
                const persona = getCurrentPersona();
                const fieldKey = Object.keys(item.data || {})[0] || 'description';
                const oldText = persona ? (persona[fieldKey] || '(原设定为空)') : '(未选定Persona)';
                const newText = String(item.data[fieldKey] || '');
            } else if (item.type === 'regex') {
                const oldScript = item.data?.beforeScript;
                const oldText = oldScript ? (oldScript.replaceString || '') : '(ST中暂无此正则脚本，本次为新增)';
                const newText = item.data?.script?.replaceString || '';
                showDiffModal(`正则代码对比: [${item.data?.scope || 'character'}] ${item.data?.scriptName || ''}`, oldText, newText);
            } else {
                showDiffModal(`数据对比: ${item.summary || item.target}`, '', JSON.stringify(item.data, null, 2));
            }
        });

        // Interactive Constant Toggle: 蓝灯(常驻) vs 绿灯(触发)
        card.find('.constant-toggle-badge').on('click', () => {
            if (!item.data) item.data = {};
            item.data.constant = !item.data.constant;
            saveWorkspace();
            renderStagingList();
        });

        // Interactive Enabled Switch: 开启 vs 关闭
        card.find('.enable-switch-badge').on('click', () => {
            if (!item.data) item.data = {};
            const curEnabled = item.data.enabled !== undefined ? !!item.data.enabled : (item.data.disable !== undefined ? !item.data.disable : true);
            const newEnabled = !curEnabled;
            item.data.enabled = newEnabled;
            item.data.disable = !newEnabled;
            saveWorkspace();
            renderStagingList();
        });

        // Interactive Order Change (顺序数值修改)
        card.find('.staged-order-input').on('change input', function () {
            if (!item.data) item.data = {};
            const val = parseInt($(this).val(), 10);
            item.data.order = isNaN(val) ? 100 : val;
            saveWorkspace();
        });

        // Interactive Position Selector (插入位置切换)
        card.find('.staged-pos-select').on('change', function () {
            if (!item.data) item.data = {};
            const pos = parseInt($(this).val(), 10);
            item.data.position = isNaN(pos) ? 0 : pos;
            if (pos === 4 && item.data.depth === undefined) {
                item.data.depth = 4;
            }
            saveWorkspace();
            renderStagingList();
        });

        // Interactive Depth Change (深度数值修改)
        card.find('.staged-depth-input').on('change input', function () {
            if (!item.data) item.data = {};
            const val = parseInt($(this).val(), 10);
            item.data.depth = isNaN(val) ? 4 : val;
            saveWorkspace();
        });

        container.append(card);
    }
}

export function renderHistoryList() {
    const history = getHistoryEntries();
    const container = $('#worldlore_history_list');
    container.empty();

    $('#worldlore_history_count_text').text(`${history.length} 条操作记录`);

    if (history.length === 0) {
        container.html('<div class="worldlore-empty-hint"><i class="fa-solid fa-clock-rotate-left"></i><br/>暂无操作日志</div>');
        return;
    }

    for (const item of history) {
        const typeIcons = {
            lorebook: 'fa-book-atlas',
            character: 'fa-user-tag',
            persona: 'fa-user-pen',
            workspace: 'fa-file-signature',
            regex: 'fa-code',
            tool: 'fa-bolt'
        };

        const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const hasDiff = !!(item.beforeState || item.afterState);

        const card = $(`
            <div class="worldlore-history-card ${item.undone ? 'is-undone' : ''}">
                <div class="card-header">
                    <div class="card-title-wrapper">
                        <i class="fa-solid ${typeIcons[item.type] || 'fa-clock'} card-type-icon"></i>
                        <span class="card-summary-text ${item.undone ? 'line-through' : ''}" title="${escapeHtml(item.summary)}">${escapeHtml(item.summary)}</span>
                    </div>
                    <div class="card-actions">
                        <span class="history-time worldlore-nowrap-text">${timeStr}</span>
                        ${hasDiff ? `
                            <button class="diff-btn menu_button fa-solid fa-code-compare" title="查看历史快照对比 (Diff)"></button>
                        ` : ''}
                        ${!item.undone && item.canUndo ? `
                            <button class="undo-btn menu_button fa-solid fa-rotate-left" title="撤回此项变更"></button>
                        ` : ''}
                        ${item.undone ? `
                            <button class="restage-btn menu_button fa-solid fa-code-pull-request" title="重新放回待确认暂存区 (Re-Stage)"></button>
                            <button class="redo-btn menu_button primary fa-solid fa-rotate-right" title="重做并直接生效 (Redo)"></button>
                        ` : ''}
                    </div>
                </div>
                ${item.undone ? '<div class="history-undone-badge worldlore-nowrap-text"><i class="fa-solid fa-arrow-rotate-left"></i> 已撤回（点击右侧图标可重做或重新暂存）</div>' : ''}
            </div>
        `);

        // Diff action
        if (hasDiff) {
            card.find('.diff-btn').on('click', () => {
                if (item.type === 'regex') {
                    const oldCode = item.beforeState?.script?.replaceString || (typeof item.beforeState?.content === 'string' ? item.beforeState.content : '');
                    const newCode = item.afterState?.script?.replaceString || (typeof item.afterState?.content === 'string' ? item.afterState.content : '');
                    showDiffModal(`正则快照对比: ${item.summary || item.target}`, oldCode, newCode);
                    return;
                }
                const oldText = typeof item.beforeState?.content === 'string' ? item.beforeState.content : (item.beforeState ? JSON.stringify(item.beforeState, null, 2) : '');
                const newText = typeof item.afterState?.content === 'string' ? item.afterState.content : (item.afterState ? JSON.stringify(item.afterState, null, 2) : '');
                showDiffModal(`历史对比: ${item.summary || item.target}`, oldText, newText);
            });
        }

        // Undo action
        card.find('.undo-btn').on('click', async () => {
            const conf = await Popup.show.confirm('确认撤回', `确定要撤回操作 "${item.summary}" 吗？`);
            if (conf) {
                try {
                    const res = await undoHistoryRecord(item.id);
                    toastr.success(res.message);
                    renderHistoryList();
                } catch (e) {
                    toastr.error(`撤回失败: ${e.message}`);
                }
            }
        });

        // Redo action
        card.find('.redo-btn').on('click', async () => {
            try {
                const res = await redoHistoryRecord(item.id);
                toastr.success(res.message);
                renderHistoryList();
            } catch (e) {
                toastr.error(`重做失败: ${e.message}`);
            }
        });

        // Re-Stage action
        card.find('.restage-btn').on('click', () => {
            try {
                const staged = restageHistoryRecord(item.id);
                toastr.success(`已重新推送到暂存区！`);
                switchTab('staging');
            } catch (e) {
                toastr.error(`重新暂存失败: ${e.message}`);
            }
        });

        container.append(card);
    }
}

function renderStagingDataDetails(item) {
    if (item.type === 'lorebook') {
        const d = item.data || {};
        const isConstant = !!d.constant;
        const isEnabled = d.enabled !== undefined ? !!d.enabled : (d.disable !== undefined ? !d.disable : true);
        const orderVal = d.order ?? 100;
        const posVal = d.position ?? 0;
        const depthVal = d.depth ?? 4;

        return `
            <div class="staged-details transparent-box">
                <!-- Interactive Lights & Order & Position Controls (酒馆标准表述: 蓝灯/绿灯, 开启/关闭) -->
                <div class="staged-lights-bar">
                    <!-- Constant/Trigger Mode toggle: 蓝灯(常驻) vs 绿灯(触发) -->
                    <span class="light-indicator constant-toggle-badge editable ${isConstant ? 'blue-mode' : 'green-mode'}" title="点击切换：蓝灯(常驻生效) / 绿灯(关键词触发)">
                        <i class="fa-solid fa-lightbulb"></i> ${isConstant ? '蓝灯' : '绿灯'}
                    </span>

                    <!-- Enable/Disable Switch toggle: 开启 vs 关闭 -->
                    <span class="light-indicator enable-switch-badge editable ${isEnabled ? 'state-on' : 'state-off'}" title="点击切换：开启 / 关闭">
                        <i class="fa-solid fa-power-off"></i> ${isEnabled ? '开启' : '关闭'}
                    </span>

                    <!-- Editable Order Pill -->
                    <span class="attribute-pill editable-pill worldlore-nowrap-text" title="排序优先级 (数字越大越优先)">
                        <i class="fa-solid fa-arrow-down-1-9"></i> 顺序:
                        <input type="number" class="staged-order-input" value="${orderVal}" />
                    </span>

                    <!-- Editable Position & Depth Pill -->
                    <span class="attribute-pill editable-pill worldlore-nowrap-text" title="插入位置">
                        <i class="fa-solid fa-layer-group"></i>
                        <select class="staged-pos-select">
                            <option value="0" ${posVal === 0 ? 'selected' : ''}>前置角色</option>
                            <option value="1" ${posVal === 1 ? 'selected' : ''}>后置角色</option>
                            <option value="2" ${posVal === 2 ? 'selected' : ''}>前置AN</option>
                            <option value="3" ${posVal === 3 ? 'selected' : ''}>后置AN</option>
                            <option value="4" ${posVal === 4 ? 'selected' : ''}>深度插入</option>
                            <option value="5" ${posVal === 5 ? 'selected' : ''}>前置示例</option>
                            <option value="6" ${posVal === 6 ? 'selected' : ''}>后置示例</option>
                        </select>
                        ${posVal === 4 ? `
                            <span class="depth-wrapper">
                                深:<input type="number" class="staged-depth-input" value="${depthVal}" min="0" max="99" />
                            </span>
                        ` : ''}
                    </span>
                </div>

                ${d.keys ? `<div class="detail-row"><i class="fa-solid fa-key"></i> <span class="keys-tag">${Array.isArray(d.keys) ? d.keys.join(', ') : d.keys}</span></div>` : ''}
                ${d.secondary_keys ? `<div class="detail-row"><i class="fa-solid fa-filter"></i> <span class="keys-tag secondary">${Array.isArray(d.secondary_keys) ? d.secondary_keys.join(', ') : d.secondary_keys}</span></div>` : ''}
                ${d.content ? `<div class="detail-content"><pre class="clean-pre">${escapeHtml(d.content)}</pre></div>` : ''}
            </div>
        `;
    } else if (item.type === 'character' || item.type === 'persona') {
        const d = item.data;
        const fields = Object.entries(d).map(([k, v]) => `<div><strong>${k}:</strong> <pre class="clean-pre">${escapeHtml(String(v))}</pre></div>`).join('');
        return `<div class="staged-details transparent-box">${fields}</div>`;
    } else if (item.type === 'regex') {
        const d = item.data || {};
        const script = d.script || {};
        const scopeBadgeMap = {
            character: '<span class="attribute-pill" style="color:var(--SmartThemeQuoteColor,#a29bfe);"><i class="fa-solid fa-user-tag"></i> 角色专属</span>',
            global: '<span class="attribute-pill" style="color:#00cec9;"><i class="fa-solid fa-globe"></i> 全局生效</span>',
            preset: '<span class="attribute-pill" style="color:#fdcb6e;"><i class="fa-solid fa-sliders"></i> 生成预设</span>'
        };
        const scopeHtml = scopeBadgeMap[d.scope] || `<span class="attribute-pill">${escapeHtml(d.scope || 'character')}</span>`;
        const findStr = script.findRegex ? `<code>${escapeHtml(script.findRegex)}</code>` : '<em>(未设置)</em>';
        const len = (script.replaceString || '').length;

        return `
            <div class="staged-details transparent-box">
                <div class="staged-lights-bar">
                    ${scopeHtml}
                    <span class="attribute-pill worldlore-nowrap-text" title="触发匹配的正则表达式">
                        <i class="fa-solid fa-magnifying-glass"></i> 正则: ${findStr}
                    </span>
                    <span class="attribute-pill worldlore-nowrap-text" title="HTML替换代码字符数">
                        <i class="fa-solid fa-file-code"></i> 代码: ${len} 字符
                    </span>
                </div>
                ${d.from_folder ? `<div class="detail-row" style="margin-top:6px;font-size:12px;opacity:0.85;"><i class="fa-regular fa-folder-open"></i> 草稿来源: <code>${escapeHtml(d.from_folder)}</code></div>` : ''}
            </div>
        `;
    }
    return `<div class="staged-details transparent-box"><pre class="clean-pre">${escapeHtml(JSON.stringify(item.data, null, 2))}</pre></div>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function updateStagingCounter() {
    const count = getStagingEntries().length;
    const badge = $('.worldlore-badge-counter');
    const tabBadge = $('.worldlore-tab-counter');

    if (count > 0) {
        badge.text(count).show();
        tabBadge.text(count).show();
    } else {
        badge.hide();
        tabBadge.hide();
    }
}

function updateStats() {
    const char = getCurrentCharacter();
    const persona = getCurrentPersona();
    const bound = getCharacterBoundLorebooks();

    $('#worldlore_stat_char').text(char ? `${char.name} (ID: ${char.id})` : '未选定角色卡');
    $('#worldlore_stat_persona').text(persona ? `${persona.name}` : '默认');
    $('#worldlore_stat_wi').text(bound.length > 0 ? `绑定: ${bound.join(', ')}` : '未绑定专属世界书');
}

// --- QR BAR DRAFT PICKER POPOVER ---
let currentQrTab = 'drafts';

export function unmountQrDraftButton() {
    const btn = document.getElementById('worldlore_qr_draft_btn');
    if (btn) btn.remove();
    const popover = document.getElementById('worldlore_qr_popover');
    if (popover) popover.classList.remove('open');
}

export function mountQrDraftButton() {
    const settings = getSettings();
    if (settings.enabled === false) {
        unmountQrDraftButton();
        return;
    }

    if (document.getElementById('worldlore_qr_draft_btn')) return;

    const btn = document.createElement('div');
    btn.id = 'worldlore_qr_draft_btn';
    btn.className = 'qr--button menu_button fa-solid fa-file-lines worldlore-qr-btn';
    btn.setAttribute('title', '引用设定 (草稿/角色/用户/世界书)');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const popover = document.getElementById('worldlore_qr_popover');
        if (popover) toggleQrPopover(btn, popover);
    });

    // 1. Mount directly inside the QR buttons container so it sits on the SAME row with sibling icons!
    const qrButtons = document.querySelector('#qr--bar .qr--buttons:last-of-type') || document.querySelector('#qr--bar .qr--buttons');
    if (qrButtons) {
        qrButtons.appendChild(btn);
        return;
    }

    // 2. Try inside #qr--bar
    const qrBar = document.getElementById('qr--bar');
    if (qrBar) {
        qrBar.appendChild(btn);
        return;
    }

    // 3. Fallback: inside #leftSendForm
    const leftSendForm = document.getElementById('leftSendForm');
    if (leftSendForm) {
        leftSendForm.appendChild(btn);
        return;
    }

    // 4. Fallback: inside #send_form
    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        sendForm.appendChild(btn);
    }
}

function initQrDraftPicker() {
    // 1. Create Popover container in body
    let popover = document.getElementById('worldlore_qr_popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'worldlore_qr_popover';
        popover.className = 'worldlore-qr-popover';
        popover.setAttribute('data-worldlore-theme', getSettings().ui?.theme || 'default');
        popover.innerHTML = `
            <div class="worldlore-qr-popover-header">
                <div class="worldlore-qr-tabs flex-container flexGap5">
                    <button class="worldlore-qr-tab-btn active" data-tab="drafts" title="草稿 (工作区文件)">
                        <i class="fa-solid fa-file-lines"></i>
                    </button>
                    <button class="worldlore-qr-tab-btn" data-tab="character" title="角色 (当前角色卡设定)">
                        <i class="fa-solid fa-user"></i>
                    </button>
                    <button class="worldlore-qr-tab-btn" data-tab="persona" title="用户 (Persona描述)">
                        <i class="fa-solid fa-user-gear"></i>
                    </button>
                    <button class="worldlore-qr-tab-btn" data-tab="lorebook" title="世界书 (已激活条目)">
                        <i class="fa-solid fa-book"></i>
                    </button>
                </div>
                <div class="flex-container flexGap5 alignitemscenter">
                    <button id="worldlore_qr_mode_btn" class="worldlore-qr-tool-btn" title="切换引用模式：【全文注入】或【仅注入名称】">
                        <i class="fa-solid fa-file-lines"></i>
                    </button>
                    <button id="worldlore_qr_pin_btn" class="worldlore-qr-tool-btn" title="保留上一轮引用 (发送消息后自动保留此引用标签)">
                        <i class="fa-solid fa-thumbtack"></i>
                    </button>
                    <button id="worldlore_qr_popover_close" class="worldlore-qr-tool-btn" title="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div id="worldlore_qr_list" class="worldlore-qr-list"></div>
        `;
        document.body.appendChild(popover);

        // Wire close button
        popover.querySelector('#worldlore_qr_popover_close').addEventListener('click', (e) => {
            e.stopPropagation();
            popover.classList.remove('open');
        });

        // Wire mode toggle button (Full vs Name-only)
        const modeBtn = popover.querySelector('#worldlore_qr_mode_btn');
        const updateModeBtnState = () => {
            const settings = getSettings();
            const isNameOnly = settings.qrReferenceMode === 'name';
            modeBtn.classList.toggle('active', isNameOnly);
            modeBtn.innerHTML = isNameOnly
                ? '<i class="fa-solid fa-tag"></i>'
                : '<i class="fa-solid fa-file-lines"></i>';
            modeBtn.setAttribute('title', isNameOnly
                ? '引用模式：当前为【仅注入名称】(点击切换为【全文注入】)'
                : '引用模式：当前为【全文注入】(点击切换为【仅注入名称】)');
        };
        updateModeBtnState();

        modeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const settings = getSettings();
            settings.qrReferenceMode = settings.qrReferenceMode === 'name' ? 'full' : 'name';
            saveWorkspace();
            updateModeBtnState();
            renderQrContent(popover, currentQrTab);
            toastr.info(settings.qrReferenceMode === 'name'
                ? '已切换为：仅注入设定名称 (不展开全文，极大节省 Token)'
                : '已切换为：注入完整设定内容');
        });

        // Wire pin (retain) button
        const pinBtn = popover.querySelector('#worldlore_qr_pin_btn');
        const updatePinState = () => {
            const settings = getSettings();
            pinBtn.classList.toggle('active', !!settings.retainDraftReference);
        };
        updatePinState();

        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const settings = getSettings();
            settings.retainDraftReference = !settings.retainDraftReference;
            saveWorkspace();
            updatePinState();
            toastr.success(settings.retainDraftReference
                ? '已开启：发送消息后自动保留引用标签'
                : '已关闭：发送后自动清除引用');
        });

        // Wire tab switching
        popover.querySelectorAll('.worldlore-qr-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                popover.querySelectorAll('.worldlore-qr-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentQrTab = btn.getAttribute('data-tab') || 'drafts';
                renderQrContent(popover, currentQrTab);
                const triggerBtn = document.getElementById('worldlore_qr_draft_btn');
                if (triggerBtn) positionQrPopover(triggerBtn, popover);
            });
        });
    }

    // 2. Mount immediately if enabled
    mountQrDraftButton();

    // 3. Observe send_form for DOM updates (e.g. character switch or QR reload)
    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        const observer = new MutationObserver(() => {
            const settings = getSettings();
            if (settings.enabled === false) {
                unmountQrDraftButton();
                return;
            }
            if (!document.getElementById('worldlore_qr_draft_btn')) {
                mountQrDraftButton();
            }
        });
        observer.observe(sendForm, { childList: true, subtree: true });
    }

    // 4. Close popover when clicking outside
    document.addEventListener('click', (e) => {
        const p = document.getElementById('worldlore_qr_popover');
        const b = document.getElementById('worldlore_qr_draft_btn');
        if (!p || !p.classList.contains('open')) return;
        if (!p.contains(e.target) && !b?.contains(e.target)) {
            p.classList.remove('open');
        }
    });

    // 5. Retain reference after message is sent
    if (eventSource && event_types?.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, () => {
            const settings = getSettings();
            if (settings.retainDraftReference && settings.lastInjectedReference) {
                setTimeout(() => {
                    const ta = document.getElementById('send_textarea');
                    if (ta && !ta.value.includes(settings.lastInjectedReference)) {
                        ta.value = `${settings.lastInjectedReference} ${ta.value}`;
                        ta.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, 80);
            }
        });
    }
}

function positionQrPopover(btn, popover) {
    const rect = btn.getBoundingClientRect();
    const availableHeightAbove = Math.max(120, rect.top - 20);
    popover.style.maxHeight = `${Math.min(380, availableHeightAbove)}px`;
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    popover.style.top = 'auto';
    popover.style.left = `${Math.max(10, Math.min(window.innerWidth - 290, rect.left))}px`;
}

function toggleQrPopover(btn, popover) {
    if (popover.classList.contains('open')) {
        popover.classList.remove('open');
        return;
    }

    renderQrContent(popover, currentQrTab);
    popover.classList.add('open');
    positionQrPopover(btn, popover);
}

function renderQrContent(popover, tab) {
    const listEl = popover.querySelector('#worldlore_qr_list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const settings = getSettings();
    const isNameOnly = settings.qrReferenceMode === 'name';

    const appendQrItem = ({ icon, label, subLabel, primaryTag, secondaryTag, tooltip }) => {
        const item = document.createElement('div');
        item.className = 'worldlore-qr-item';
        item.setAttribute('title', `${tooltip}\n（点击整行插入【${isNameOnly ? '仅名称' : '全文'}】；点击右侧标签以相反模式插入）`);
        item.innerHTML = `
            <i class="fa-solid fa-${icon}"></i>
            <span class="worldlore-nowrap-text" style="flex: 1;">${label}${subLabel ? ` <small style="opacity:0.65">(${subLabel})</small>` : ''}</span>
            <span class="worldlore-qr-item-mode-tag" title="以【${isNameOnly ? '全文' : '仅名称'}】模式快速引用"><i class="fa-solid fa-${isNameOnly ? 'file-lines' : 'tag'}"></i></span>
        `;
        // Clicking row inserts primary tag
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            insertDraftReference(primaryTag);
            popover.classList.remove('open');
        });
        // Clicking mode tag specifically inserts secondary tag
        const modeTag = item.querySelector('.worldlore-qr-item-mode-tag');
        if (modeTag) {
            modeTag.addEventListener('click', (e) => {
                e.stopPropagation();
                insertDraftReference(secondaryTag);
                popover.classList.remove('open');
            });
        }
        listEl.appendChild(item);
    };

    if (tab === 'drafts') {
        const files = listFiles();
        if (!files || files.length === 0) {
            listEl.innerHTML = '<div class="worldlore-qr-empty worldlore-nowrap-text">工作区暂无草稿</div>';
            return;
        }
        for (const file of files) {
            const fullTag = `[草稿: ${file.path}]`;
            const nameTag = `[草稿名: ${file.path}]`;
            appendQrItem({
                icon: 'file-code',
                label: file.path,
                primaryTag: isNameOnly ? nameTag : fullTag,
                secondaryTag: isNameOnly ? fullTag : nameTag,
                tooltip: `引用草稿: ${file.path}`
            });
        }
    } else if (tab === 'character') {
        const char = getCurrentCharacter();
        if (!char) {
            listEl.innerHTML = '<div class="worldlore-qr-empty worldlore-nowrap-text">当前未选定角色卡</div>';
            return;
        }
        const charFields = [
            { key: 'description', label: '角色描述 (Description)' },
            { key: 'personality', label: '性格特征 (Personality)' },
            { key: 'scenario', label: '对话场景 (Scenario)' },
            { key: 'first_mes', label: '首条问候 (First Message)' },
            { key: 'mes_example', label: '对话样例 (Examples)' },
        ];
        for (const f of charFields) {
            const fullTag = `[角色设定: ${char.name}.${f.key}]`;
            const nameTag = `[角色设定名: ${char.name}.${f.key}]`;
            appendQrItem({
                icon: 'id-card',
                label: `${char.name} · ${f.label}`,
                primaryTag: isNameOnly ? nameTag : fullTag,
                secondaryTag: isNameOnly ? fullTag : nameTag,
                tooltip: `引用角色设定: ${char.name}.${f.key}`
            });
        }
    } else if (tab === 'persona') {
        const persona = getCurrentPersona();
        if (!persona) {
            listEl.innerHTML = '<div class="worldlore-qr-empty worldlore-nowrap-text">未选定用户 Persona</div>';
            return;
        }
        const pFields = [
            { key: 'description', label: '用户描述 (Description)' },
        ];
        for (const f of pFields) {
            const fullTag = `[用户设定: ${persona.name || '用户'}.${f.key}]`;
            const nameTag = `[用户设定名: ${persona.name || '用户'}.${f.key}]`;
            appendQrItem({
                icon: 'user-pen',
                label: `${persona.name || '用户'} · ${f.label}`,
                primaryTag: isNameOnly ? nameTag : fullTag,
                secondaryTag: isNameOnly ? fullTag : nameTag,
                tooltip: `引用用户设定: ${persona.name || '用户'}.${f.key}`
            });
        }
    } else if (tab === 'lorebook') {
        let entries = [];
        try {
            const res = readLorebookEntriesScoped('active');
            entries = res?.entries || [];
        } catch (e) {
            console.warn('[Worldlore Agent] Could not read active lorebooks:', e);
        }
        if (!entries || entries.length === 0) {
            listEl.innerHTML = '<div class="worldlore-qr-empty worldlore-nowrap-text">当前无激活的世界书条目</div>';
            return;
        }
        for (const entry of entries) {
            const fullTag = `[世界书条目: ${entry.book} > ${entry.comment}]`;
            const nameTag = `[世界书条目名: ${entry.book} > ${entry.comment}]`;
            appendQrItem({
                icon: 'book-bookmark',
                label: entry.comment || '无备注',
                subLabel: entry.book,
                primaryTag: isNameOnly ? nameTag : fullTag,
                secondaryTag: isNameOnly ? fullTag : nameTag,
                tooltip: `引用世界书条目: ${entry.book} > ${entry.comment}`
            });
        }
    }
}

function insertDraftReference(refText) {
    const ta = document.getElementById('send_textarea');
    if (!ta) return;

    const toInsert = `${refText} `;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const val = ta.value;

    ta.value = val.substring(0, start) + toInsert + val.substring(end);
    ta.selectionStart = ta.selectionEnd = start + toInsert.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();

    const settings = getSettings();
    settings.lastInjectedReference = refText;
    saveWorkspace();

    toastr.info(`已插入引用: ${refText}`);
}
