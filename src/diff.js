import { DiffMatchPatch } from '/lib.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Computes unified diff HTML with <del> and <ins> tags.
 */
export function computeDiffHtml(oldText = '', newText = '') {
    try {
        const dmp = typeof DiffMatchPatch !== 'undefined'
            ? new DiffMatchPatch()
            : (window.diff_match_patch ? new window.diff_match_patch() : null);

        if (!dmp) {
            return fallbackDiffHtml(oldText, newText);
        }

        const diffs = dmp.diff_main(oldText, newText);
        dmp.diff_cleanupSemantic(diffs);

        let html = '';
        let delCount = 0;
        let insCount = 0;

        for (const [op, data] of diffs) {
            const escaped = escapeHtml(data);
            if (op === -1) {
                html += `<del class="worldlore-diff-del">${escaped}</del>`;
                delCount += data.length;
            } else if (op === 1) {
                html += `<ins class="worldlore-diff-ins">${escaped}</ins>`;
                insCount += data.length;
            } else {
                html += `<span>${escaped}</span>`;
            }
        }

        return { html, delCount, insCount };
    } catch (e) {
        console.warn('[Worldlore Agent] Diff error, using fallback:', e);
        return fallbackDiffHtml(oldText, newText);
    }
}

function fallbackDiffHtml(oldText = '', newText = '') {
    return {
        html: `<del class="worldlore-diff-del">${escapeHtml(oldText)}</del><br/><ins class="worldlore-diff-ins">${escapeHtml(newText)}</ins>`,
        delCount: oldText.length,
        insCount: newText.length
    };
}

/**
 * Opens a modal dialog showing the visual diff between oldText and newText.
 * Supports toggling between Unified (内联) and Split (双栏) views.
 * 
 * @param {string} title
 * @param {string} oldText
 * @param {string} newText
 */
export function showDiffModal(title, oldText = '', newText = '') {
    const { html: unifiedHtml, delCount, insCount } = computeDiffHtml(oldText, newText);

    const container = document.createElement('div');
    container.className = 'worldlore-diff-modal-container';
    container.innerHTML = `
        <div class="worldlore-diff-modal-header">
            <div class="worldlore-diff-title flex-container alignitemscenter flexGap5">
                <i class="fa-solid fa-code-compare"></i>
                <span class="worldlore-nowrap-text" style="font-weight:600;font-size:14px;">${escapeHtml(title)}</span>
            </div>
            <div class="worldlore-diff-stats flex-container alignitemscenter flexGap5">
                <span class="worldlore-diff-badge-del"><i class="fa-solid fa-minus"></i> ${delCount} 字</span>
                <span class="worldlore-diff-badge-ins"><i class="fa-solid fa-plus"></i> ${insCount} 字</span>
            </div>
            <div class="worldlore-diff-view-modes flex-container flexGap5">
                <button class="menu_button worldlore-diff-mode-btn active" data-mode="unified" title="内联对比视图">
                    <i class="fa-solid fa-bars-staggered"></i>
                </button>
                <button class="menu_button worldlore-diff-mode-btn" data-mode="split" title="双栏对比视图">
                    <i class="fa-solid fa-table-columns"></i>
                </button>
            </div>
        </div>

        <!-- 1. Unified Inline View -->
        <div class="worldlore-diff-view worldlore-diff-unified-view">
            <pre class="worldlore-diff-pre">${unifiedHtml}</pre>
        </div>

        <!-- 2. Split Side-by-Side View -->
        <div class="worldlore-diff-view worldlore-diff-split-view displayNone">
            <div class="worldlore-diff-split-col col-old">
                <div class="worldlore-diff-split-header">
                    <i class="fa-solid fa-clock-rotate-left"></i> 修改前 (原内容)
                </div>
                <pre class="worldlore-diff-pre">${escapeHtml(oldText)}</pre>
            </div>
            <div class="worldlore-diff-split-col col-new">
                <div class="worldlore-diff-split-header">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 修改后 (新内容)
                </div>
                <pre class="worldlore-diff-pre">${escapeHtml(newText)}</pre>
            </div>
        </div>
    `;

    // Bind mode toggle buttons
    const modeBtns = container.querySelectorAll('.worldlore-diff-mode-btn');
    const unifiedView = container.querySelector('.worldlore-diff-unified-view');
    const splitView = container.querySelector('.worldlore-diff-split-view');

    modeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            modeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const mode = btn.getAttribute('data-mode');
            if (mode === 'split') {
                unifiedView.classList.add('displayNone');
                splitView.classList.remove('displayNone');
            } else {
                splitView.classList.add('displayNone');
                unifiedView.classList.remove('displayNone');
            }
        });
    });

    const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: '关闭'
    });
    popup.show();
}
