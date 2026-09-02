import { getSettings, saveWorkspace, getProjects, getActiveProjectName, getActiveProject, createProject, switchProject, deleteProject, listFiles, readFile, writeFile, deleteFile, exportProjectData, importProjectData } from './workspace.js';
import { getStagingEntries, removeStagingEntry, clearStaging, applyStagingEntry, applyAllStaging, getHistoryEntries, undoHistoryRecord, redoHistoryRecord, restageHistoryRecord, clearHistory, getToolDocumentationPrompt, setToolMode } from './tools.js';
import { getAvailableWorldInfos, getCharacterBoundLorebooks, getCurrentCharacter, getCurrentPersona, getLorebooksOverview, readLorebookEntriesScoped } from './st-sync.js';
import { eventSource, event_types } from '/script.js';
import { Popup } from '/scripts/popup.js';

let currentSelectedFile = null;
let lastToggleTime = 0;

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

function createDrawer() {
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
                <button class="worldlore-tab-btn" data-tab="guide" title="提示词指南">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
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
                            <button id="worldlore_export_project_btn" class="menu_button fa-solid fa-file-export" title="导出项目"></button>
                            <button id="worldlore_import_project_btn" class="menu_button fa-solid fa-file-import" title="导入项目"></button>
                            <button id="worldlore_delete_project_btn" class="menu_button fa-solid fa-trash" title="删除项目"></button>
                            <input type="file" id="worldlore_import_file_input" style="display:none;" accept=".json" />
                        </div>

                        <!-- Search file -->
                        <input type="text" id="worldlore_file_search_input" class="worldlore-input" placeholder="搜索草稿文件..." />

                        <!-- Spacious File List Container -->
                        <div id="worldlore_file_list" class="worldlore-file-list unified-spacious-list"></div>
                    </div>
                </div>

                <!-- Full-Height Editor Body -->
                <div class="worldlore-editor-full-container">
                    <div class="worldlore-editor-header">
                        <div class="editor-filename-wrap worldlore-nowrap-text">
                            <i class="fa-solid fa-pen-to-square"></i>
                            <span id="worldlore_editor_filename">world/overview.md</span>
                        </div>
                        <div class="worldlore-editor-actions">
                            <button id="worldlore_save_file_btn" class="menu_button primary fa-solid fa-floppy-disk" title="保存草稿"></button>
                            <button id="worldlore_delete_file_btn" class="menu_button fa-solid fa-trash" title="删除草稿"></button>
                        </div>
                    </div>
                    <textarea id="worldlore_file_editor" class="worldlore-textarea editor-fullscreen" placeholder="在上方展开栏中选择文件查看与编辑，或由 Agent 写入..."></textarea>
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

            <!-- TAB 4: PROMPT GUIDE -->
            <div class="worldlore-tab-pane" id="worldlore_pane_guide">
                <div class="worldlore-guide-container">
                    <div class="worldlore-guide-header">
                        <i class="fa-solid fa-circle-info"></i>
                        <span class="worldlore-nowrap-text">A助手 指南</span>
                    </div>

                    <div class="worldlore-section-label worldlore-nowrap-text">工具调用模式</div>
                    <div class="worldlore-mode-toggle" id="worldlore_mode_toggle">
                        <button id="worldlore_mode_native_btn" class="menu_button worldlore-mode-btn" title="原生 Function Calling 模式（工具调用走 API 协议，有 Role:tool 历史注入）">
                            <i class="fa-solid fa-plug"></i>
                        </button>
                        <button id="worldlore_mode_text_btn" class="menu_button worldlore-mode-btn" title="文本标签模式（AI 输出 &lt;agent_action&gt; 标签，本地执行，零上下文注入）">
                            <i class="fa-solid fa-tag"></i>
                        </button>
                    </div>
                    <div id="worldlore_mode_label" class="worldlore-mode-label worldlore-nowrap-text"></div>

                    <p>点击下方按钮可一键复制工具说明并粘贴至 System Prompt 或预设（内容随模式自动更新）：</p>
                    
                    <div class="worldlore-copy-box">
                        <button id="worldlore_copy_prompt_btn" class="menu_button primary fa-solid fa-copy" title="一键复制完整工具说明 (Copy Tool Prompt)"></button>
                    </div>

                    <div class="worldlore-status-summary">
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
            $('#worldlore_save_file_btn, #worldlore_delete_file_btn').hide();
        }
    });

    $('#worldlore_file_search_input').on('input', function () {
        const q = $(this).val().toLowerCase();
        renderFileList(q);
    });

    $('#worldlore_copy_prompt_btn').on('click', () => {
        const text = getToolDocumentationPrompt();
        navigator.clipboard.writeText(text).then(() => {
            toastr.success('已复制工具提示词说明到剪贴板！');
        });
    });

    // --- TOOL MODE TOGGLE ---
    const renderModeLabel = () => {
        const mode = getSettings().toolMode || 'native';
        const isNative = mode === 'native';
        $('#worldlore_mode_native_btn').toggleClass('active', isNative);
        $('#worldlore_mode_text_btn').toggleClass('active', !isNative);
        $('#worldlore_mode_label').text(isNative
            ? '原生模式：工具调用走 API 协议'
            : '文本模式：<agent_action> 标签，零上下文注入');
    };

    $('#worldlore_mode_native_btn').on('click', () => {
        setToolMode('native');
        renderModeLabel();
        toastr.success('已切换至原生 Function Calling 模式');
    });

    $('#worldlore_mode_text_btn').on('click', () => {
        setToolMode('text');
        renderModeLabel();
        toastr.success('已切换至文本标签模式，上下文零注入');
    });

    // Init label on load
    renderModeLabel();

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

function switchTab(tabName) {
    $('.worldlore-tab-btn').removeClass('active');
    $(`.worldlore-tab-btn[data-tab="${tabName}"]`).addClass('active');
    $('.worldlore-tab-pane').removeClass('active');
    $(`#worldlore_pane_${tabName}`).addClass('active');

    requestAnimationFrame(() => {
        if (tabName === 'workspace') refreshWorkspaceUI();
        if (tabName === 'staging') renderStagingList();
        if (tabName === 'history') renderHistoryList();
        if (tabName === 'guide') updateStats();
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

function renderFileList(query = '') {
    const container = $('#worldlore_file_list');
    container.empty();
    const files = listFiles();

    const filtered = query ? files.filter(f => f.path.toLowerCase().includes(query.toLowerCase())) : files;

    if (filtered.length === 0) {
        container.html('<div class="worldlore-empty-hint"><i class="fa-solid fa-folder-open"></i><br/><span style="font-size:12px;">无草稿文件</span></div>');
        return;
    }

    for (const file of filtered) {
        const item = $(`
            <div class="worldlore-file-item ${currentSelectedFile === file.path ? 'active' : ''}">
                <i class="fa-solid fa-file-lines file-icon"></i>
                <span class="file-path">${file.path}</span>
                <span class="file-size">${file.length}b</span>
            </div>
        `);

        item.on('click', () => {
            currentSelectedFile = file.path;
            $('.worldlore-file-item').removeClass('active');
            item.addClass('active');
            loadFileToEditor(file.path);
        });

        container.append(item);
    }
}

function loadFileToEditor(path) {
    const content = readFile(path);
    if (content !== null) {
        $('#worldlore_editor_filename').text(path);
        $('#worldlore_cur_file_name').text(path);
        $('#worldlore_file_editor').val(content);
        $('#worldlore_save_file_btn, #worldlore_delete_file_btn').show();
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
            workspace: 'fa-file-signature'
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
            tool: 'fa-bolt'
        };

        const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const card = $(`
            <div class="worldlore-history-card ${item.undone ? 'is-undone' : ''}">
                <div class="card-header">
                    <div class="card-title-wrapper">
                        <i class="fa-solid ${typeIcons[item.type] || 'fa-clock'} card-type-icon"></i>
                        <span class="card-summary-text ${item.undone ? 'line-through' : ''}" title="${escapeHtml(item.summary)}">${escapeHtml(item.summary)}</span>
                    </div>
                    <div class="card-actions">
                        <span class="history-time worldlore-nowrap-text">${timeStr}</span>
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

    if (tab === 'drafts') {
        const files = listFiles();
        if (!files || files.length === 0) {
            listEl.innerHTML = '<div class="worldlore-qr-empty worldlore-nowrap-text">工作区暂无草稿</div>';
            return;
        }
        for (const file of files) {
            const item = document.createElement('div');
            item.className = 'worldlore-qr-item';
            item.setAttribute('title', `点击引用 [草稿: ${file.path}]`);
            item.innerHTML = `
                <i class="fa-solid fa-file-code"></i>
                <span class="worldlore-nowrap-text">${file.path}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                insertDraftReference(`[草稿: ${file.path}]`);
                popover.classList.remove('open');
            });
            listEl.appendChild(item);
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
            const item = document.createElement('div');
            item.className = 'worldlore-qr-item';
            const tag = `[角色设定: ${char.name}.${f.key}]`;
            item.setAttribute('title', `点击引用 ${tag}`);
            item.innerHTML = `
                <i class="fa-solid fa-id-card"></i>
                <span class="worldlore-nowrap-text">${char.name} · ${f.label}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                insertDraftReference(tag);
                popover.classList.remove('open');
            });
            listEl.appendChild(item);
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
            const item = document.createElement('div');
            item.className = 'worldlore-qr-item';
            const tag = `[用户设定: ${persona.name || '用户'}.${f.key}]`;
            item.setAttribute('title', `点击引用 ${tag}`);
            item.innerHTML = `
                <i class="fa-solid fa-user-pen"></i>
                <span class="worldlore-nowrap-text">${persona.name || '用户'} · ${f.label}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                insertDraftReference(tag);
                popover.classList.remove('open');
            });
            listEl.appendChild(item);
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
            const item = document.createElement('div');
            item.className = 'worldlore-qr-item';
            const tag = `[世界书条目: ${entry.book} > ${entry.comment}]`;
            item.setAttribute('title', `点击引用 ${tag}`);
            item.innerHTML = `
                <i class="fa-solid fa-book-bookmark"></i>
                <span class="worldlore-nowrap-text">${entry.comment || '无备注'} <small style="opacity:0.7">(${entry.book})</small></span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                insertDraftReference(tag);
                popover.classList.remove('open');
            });
            listEl.appendChild(item);
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
