import { getSettings } from '../core/workspace.js';

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function parseRegex(rawPattern) {
    if (!rawPattern || typeof rawPattern !== 'string') return null;
    const trimmed = rawPattern.trim();
    try {
        const slashMatch = trimmed.match(/^\/(.+)\/([a-z]*)$/s);
        if (slashMatch) {
            const flags = slashMatch[2].includes('g') ? slashMatch[2] : (slashMatch[2] + 'g');
            return new RegExp(slashMatch[1], flags);
        }
        return new RegExp(trimmed, 'g');
    } catch (err) {
        console.warn('[Worldlore Agent] Invalid regex pattern:', err);
        return null;
    }
}

export function generateMockTextFromRegex(findRegexStr) {
    if (!findRegexStr) return '';

    const tagMatches = [...findRegexStr.matchAll(/<([a-zA-Z0-9_\u4e00-\u9fa5]+)>/g)];
    if (tagMatches.length > 0) {
        const sampleValues = {
            '正文': '阳光穿透树林洒在林间小道上，微风拂过带来远方花草的芬芳。',
            '时间': '清晨 07:30',
            '地点': '中央城广场',
            '心声': '今天应该会是个好天气，得抓紧去完成委托了...',
            '状态': '健康',
            '等级': 'Lv.15',
            '生命': '100/100',
            'HP': '100/100',
            'MP': '85/85',
            '金币': '1,250 G',
            '好感': '88',
            '好感度': '88 (信任)',
            '心情': '愉悦',
            '弹幕一': '早安呀！',
            '弹幕二': '打卡打卡~',
            '弹幕三': '前排围观',
            '弹幕四': '这个状态栏排版好精致！',
            '弹幕五': '爱了爱了',
            '弹幕六': '今日宜出门冒险'
        };

        const generated = [];
        const seenTags = new Set();
        for (const m of tagMatches) {
            const tag = m[1];
            if (seenTags.has(tag)) continue;
            seenTags.add(tag);
            const val = sampleValues[tag] || `示例${tag}内容`;
            generated.push(`<${tag}>${val}</${tag}>`);
        }
        return generated.join('\n');
    }

    const bracketMatches = [...findRegexStr.matchAll(/\[([a-zA-Z0-9_\u4e00-\u9fa5]+)[:：\s]/g)];
    if (bracketMatches.length > 0) {
        return bracketMatches.map(m => `[${m[1]}: 100]`).join(' ');
    }

    return '这是一段用于测试正则替换与前端样式渲染的示例消息正文。';
}

export function buildIframeDoc(bodyHtml, isDark = false) {
    const textColor = isDark ? '#e0e0e0' : '#222222';
    const bgColor = isDark ? '#161926' : '#ffffff';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
  html, body {
    margin: 0;
    padding: 14px;
    background-color: ${bgColor};
    color: ${textColor};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    word-break: break-word;
    box-sizing: border-box;
    min-height: 100%;
    transition: background-color 0.2s, color 0.2s;
  }
  * { box-sizing: border-box; }
  pre, code { font-family: Consolas, Monaco, "Courier New", monospace; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function showHtmlPreviewModal({ title = 'HTML 预览', htmlContent = '', meta = null, defaultTestText = '' }) {
    $('.worldlore-custom-preview-overlay').remove();

    let isDarkMode = false;
    let deviceMode = 'phone';
    let currentView = 'render';
    let isTestConsoleOpen = false;

    const findRegexStr = meta?.findRegex || '';
    const compiledRegex = parseRegex(findRegexStr);

    let currentTestText = defaultTestText;
    if (!currentTestText && findRegexStr) {
        currentTestText = generateMockTextFromRegex(findRegexStr);
    }

    const theme = getSettings()?.ui?.theme || 'default';

    const overlay = document.createElement('div');
    overlay.className = 'worldlore-custom-preview-overlay';
    overlay.setAttribute('data-worldlore-theme', theme);

    overlay.innerHTML = `
        <div class="worldlore-preview-backdrop"></div>
        <div class="worldlore-preview-window">
            <!-- HEADER ROW 1 -->
            <div class="preview-win-header">
                <div class="preview-win-title-area">
                    <i class="fa-solid fa-eye preview-main-icon"></i>
                    <span class="preview-win-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                    ${findRegexStr ? '<span class="preview-tag-pill regex">正则模式</span>' : '<span class="preview-tag-pill html">HTML 模板</span>'}
                </div>
                <div class="preview-win-top-actions">
                    <button class="preview-icon-btn" id="preview_close_btn" title="关闭预览 (Esc)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>

            <!-- TOOLBAR ROW 2 -->
            <div class="preview-win-toolbar">
                <div class="preview-toolbar-left">
                    <div class="preview-seg-ctrl">
                        <button class="preview-seg-btn active" data-view="render">
                            <i class="fa-solid fa-palette"></i> 视觉渲染
                        </button>
                        <button class="preview-seg-btn" data-view="source">
                            <i class="fa-solid fa-code"></i> HTML源码
                        </button>
                    </div>

                    <div class="preview-seg-ctrl">
                        <button class="preview-seg-btn active" id="btn_dev_phone" title="手机端视口 (390px 仿真)">
                            <i class="fa-solid fa-mobile-screen"></i> 手机端
                        </button>
                        <button class="preview-seg-btn" id="btn_dev_desktop" title="全宽桌面视口">
                            <i class="fa-solid fa-desktop"></i> 全宽
                        </button>
                    </div>
                </div>

                <div class="preview-toolbar-right">
                    <button class="preview-action-btn" id="btn_theme_toggle" title="切换组件深色/浅色背景">
                        <i class="fa-solid fa-sun" style="color:#f39c12;"></i> <span>浅色底</span>
                    </button>

                    ${findRegexStr ? `
                    <button class="preview-action-btn ${isTestConsoleOpen ? 'active' : ''}" id="btn_toggle_console" title="展开/收起正则联调测试台">
                        <i class="fa-solid fa-flask"></i> <span>测试联调</span>
                    </button>
                    ` : ''}
                </div>
            </div>

            ${findRegexStr ? `
            <div class="preview-test-drawer" id="preview_test_drawer" style="display:none;">
                <div class="test-drawer-info-bar">
                    <div class="test-drawer-pattern">
                        <i class="fa-solid fa-filter" style="opacity:0.7;"></i>
                        <span class="pattern-label">匹配规则:</span>
                        <code class="pattern-code" title="${escapeHtml(findRegexStr)}">${escapeHtml(findRegexStr)}</code>
                    </div>
                    <div class="test-drawer-actions">
                        <span class="test-badge-status" id="test_match_badge">计算中...</span>
                        <button class="preview-mini-btn" id="btn_gen_mock" title="根据正则自动提取标签并填充自然对话示例">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 填充示例数据
                        </button>
                    </div>
                </div>
                <textarea class="test-drawer-textarea" id="test_text_input" placeholder="输入测试文本，实时查看正则捕获组替换后的真实效果...">${escapeHtml(currentTestText)}</textarea>
            </div>
            ` : ''}

            <!-- PREVIEW CANVAS VIEWPORT -->
            <div class="preview-canvas-viewport ${deviceMode}" id="preview_canvas_viewport">
                <div class="preview-device-frame" id="preview_device_frame">
                    <div class="preview-frame-render" id="frame_render_view">
                        <iframe id="preview_sandbox_iframe" class="preview-sandbox-iframe" sandbox="allow-scripts allow-same-origin"></iframe>
                    </div>

                    <div class="preview-frame-source" id="frame_source_view" style="display:none;">
                        <pre class="preview-source-code" id="preview_source_code"></pre>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const iframe = overlay.querySelector('#preview_sandbox_iframe');
    const sourceCodeEl = overlay.querySelector('#preview_source_code');
    const testMatchBadge = overlay.querySelector('#test_match_badge');
    const testTextInput = overlay.querySelector('#test_text_input');
    const testDrawer = overlay.querySelector('#preview_test_drawer');
    const btnToggleConsole = overlay.querySelector('#btn_toggle_console');
    const btnGenMock = overlay.querySelector('#btn_gen_mock');
    const btnThemeToggle = overlay.querySelector('#btn_theme_toggle');
    const btnDevPhone = overlay.querySelector('#btn_dev_phone');
    const btnDevDesktop = overlay.querySelector('#btn_dev_desktop');
    const canvasViewport = overlay.querySelector('#preview_canvas_viewport');
    const frameRenderView = overlay.querySelector('#frame_render_view');
    const frameSourceView = overlay.querySelector('#frame_source_view');
    const closeBtn = overlay.querySelector('#preview_close_btn');
    const backdrop = overlay.querySelector('.worldlore-preview-backdrop');
    const segButtons = overlay.querySelectorAll('.preview-seg-btn[data-view]');

    const closeModal = () => {
        $(overlay).fadeOut(150, () => $(overlay).remove());
        $(document).off('keydown.worldlore_preview');
    };

    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);
    $(document).on('keydown.worldlore_preview', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    const updatePreview = () => {
        let finalHtml = htmlContent;
        let matchCount = 0;

        if (compiledRegex && testTextInput) {
            const rawInput = testTextInput.value;
            if (rawInput) {
                const matches = rawInput.match(compiledRegex);
                matchCount = matches ? matches.length : 0;
                try {
                    finalHtml = rawInput.replace(compiledRegex, htmlContent);
                } catch (e) {
                    finalHtml = `<div style="color:#e74c3c;padding:16px;"><b>正则替换出错:</b> ${escapeHtml(e.message)}</div>`;
                }
            }

            if (testMatchBadge) {
                if (matchCount > 0) {
                    testMatchBadge.className = 'test-badge-status success';
                    testMatchBadge.innerHTML = `<i class="fa-solid fa-check"></i> 命中 ${matchCount} 处`;
                } else if (testTextInput.value.trim().length > 0) {
                    testMatchBadge.className = 'test-badge-status warn';
                    testMatchBadge.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> 未命中`;
                } else {
                    testMatchBadge.className = 'test-badge-status';
                    testMatchBadge.innerText = '直接模板';
                }
            }
        }

        if (iframe) {
            iframe.srcdoc = buildIframeDoc(finalHtml, isDarkMode);
        }

        if (sourceCodeEl) {
            sourceCodeEl.textContent = finalHtml;
        }
    };

    if (testTextInput) {
        testTextInput.addEventListener('input', updatePreview);
    }

    if (btnToggleConsole && testDrawer) {
        btnToggleConsole.addEventListener('click', () => {
            isTestConsoleOpen = !isTestConsoleOpen;
            if (isTestConsoleOpen) {
                testDrawer.style.display = 'flex';
                btnToggleConsole.classList.add('active');
            } else {
                testDrawer.style.display = 'none';
                btnToggleConsole.classList.remove('active');
            }
        });
    }

    if (btnGenMock && testTextInput) {
        btnGenMock.addEventListener('click', () => {
            const mock = generateMockTextFromRegex(findRegexStr);
            testTextInput.value = mock;
            updatePreview();
        });
    }

    if (btnDevPhone && btnDevDesktop && canvasViewport) {
        btnDevPhone.addEventListener('click', () => {
            btnDevPhone.classList.add('active');
            btnDevDesktop.classList.remove('active');
            canvasViewport.className = 'preview-canvas-viewport phone';
        });

        btnDevDesktop.addEventListener('click', () => {
            btnDevDesktop.classList.add('active');
            btnDevPhone.classList.remove('active');
            canvasViewport.className = 'preview-canvas-viewport desktop';
        });
    }

    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', () => {
            isDarkMode = !isDarkMode;
            btnThemeToggle.innerHTML = isDarkMode
                ? '<i class="fa-solid fa-moon"></i> <span>深色底</span>'
                : '<i class="fa-solid fa-sun" style="color:#f39c12;"></i> <span>浅色底</span>';
            updatePreview();
        });
    }

    segButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            segButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const view = btn.getAttribute('data-view');
            currentView = view;
            if (view === 'source') {
                frameRenderView.style.display = 'none';
                frameSourceView.style.display = 'flex';
            } else {
                frameSourceView.style.display = 'none';
                frameRenderView.style.display = 'flex';
            }
        });
    });

    updatePreview();
}
