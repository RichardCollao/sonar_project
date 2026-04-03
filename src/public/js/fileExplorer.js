let currentPath = '';
let currentTargetInputId = '';

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function joinExplorerPath(basePath, segment) {
    const left = String(basePath || '').replace(/^\/+|\/+$/g, '');
    const right = String(segment || '').replace(/^\/+|\/+$/g, '');

    if (!left) return right;
    if (!right) return left;
    return `${left}/${right}`;
}

function decodeExplorerItems(encodedItems) {
    try {
        const raw = decodeURIComponent(encodedItems || '');
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function renderExplorerBreadcrumb(pathValue) {
    const breadcrumb = document.getElementById('explorerBreadcrumb');
    if (!breadcrumb) return;

    const parts = String(pathValue || '')
        .split('/')
        .filter(Boolean);

    const html = [
        '<li class="breadcrumb-item">',
        '<button type="button" class="btn btn-link btn-sm p-0 text-decoration-none" data-explorer-breadcrumb="">/ workspace</button>',
        '</li>'
    ];

    let acc = '';
    parts.forEach(function (part, index) {
        acc = joinExplorerPath(acc, part);
        const isLast = index === parts.length - 1;

        if (isLast) {
            html.push(`<li class="breadcrumb-item active" aria-current="page">${escapeHtml(part)}</li>`);
            return;
        }

        html.push(
            '<li class="breadcrumb-item">',
            `<button type="button" class="btn btn-link btn-sm p-0 text-decoration-none" data-explorer-breadcrumb="${escapeHtml(acc)}">${escapeHtml(part)}</button>`,
            '</li>'
        );
    });

    breadcrumb.innerHTML = html.join('');
}

function renderExplorerList(items) {
    const list = document.getElementById('explorerList');
    const emptyMessage = document.getElementById('explorerEmptyMessage');
    if (!list || !emptyMessage) return;

    const safeItems = Array.isArray(items) ? items : [];

    if (safeItems.length === 0) {
        list.innerHTML = '';
        emptyMessage.classList.remove('d-none');
        return;
    }

    emptyMessage.classList.add('d-none');

    list.innerHTML = safeItems.map(function (item) {
        const isFolder = item.type === 'folder';
        const icon = isFolder ? '📁' : '📄';
        const name = escapeHtml(item.name || '');

        if (isFolder) {
            return `
                <button type="button" class="list-group-item list-group-item-action d-flex align-items-center" data-explorer-folder="${name}">
                    <span>${icon} ${name}</span>
                </button>
            `;
        }

        return `
            <div class="list-group-item d-flex align-items-center text-muted">
                <span>${icon} ${name}</span>
            </div>
        `;
    }).join('');
}

function renderExplorerState(payload) {
    currentPath = String(payload?.path || '');
    renderExplorerBreadcrumb(currentPath);
    renderExplorerList(payload?.items || []);
}

function loadExplorerPath(pathValue) {
    request('/explorer/files', 'POST', { path: String(pathValue || '') }, function (json) {
        renderExplorerState(json || { path: '', items: [] });
    });
}

async function openGlobalFileExplorerModal(targetInputId) {
    const modalElement = document.getElementById('fileExplorerModal');
    const bodyElement = document.getElementById('fileExplorerModalBody');
    if (!modalElement || !bodyElement) return;

    currentTargetInputId = String(targetInputId || '').trim();
    if (!currentTargetInputId) {
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.show();

    bodyElement.innerHTML = `
        <div class="text-center text-muted py-4">
            <div class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></div>
            Cargando explorador...
        </div>
    `;

    try {
        const response = await fetch('/explorer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ path: currentPath || '' })
        });

        if (!response.ok) {
            throw new Error(`No fue posible cargar el explorador (HTTP ${response.status}).`);
        }

        bodyElement.innerHTML = await response.text();

        const root = document.getElementById('explorerRoot');
        if (!root) {
            throw new Error('No se encontró la vista del explorador.');
        }

        const initialPath = root.dataset.path || '';
        const initialItems = decodeExplorerItems(root.dataset.items || '');
        renderExplorerState({ path: initialPath, items: initialItems });
    } catch (error) {
        bodyElement.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error?.message || 'Error cargando explorador.')}</div>`;
    }
}

function initFileExplorerEvents() {
    const modalBody = document.getElementById('fileExplorerModalBody');
    const acceptButton = document.getElementById('btnAcceptFileExplorer');
    const modalElement = document.getElementById('fileExplorerModal');

    if (modalBody) {
        modalBody.addEventListener('click', function (event) {
            const folderButton = event.target.closest('[data-explorer-folder]');
            if (folderButton) {
                const folderName = folderButton.getAttribute('data-explorer-folder') || '';
                const targetPath = joinExplorerPath(currentPath, folderName);
                loadExplorerPath(targetPath);
                return;
            }

            const breadcrumbButton = event.target.closest('[data-explorer-breadcrumb]');
            if (breadcrumbButton) {
                const targetPath = breadcrumbButton.getAttribute('data-explorer-breadcrumb') || '';
                loadExplorerPath(targetPath);
            }
        });
    }

    if (acceptButton && modalElement) {
        acceptButton.addEventListener('click', function () {
            const workingDirInput = currentTargetInputId
                ? document.getElementById(currentTargetInputId)
                : null;
            if (workingDirInput) {
                const normalized = currentPath || '';
                workingDirInput.value = normalized;
            }

            bootstrap.Modal.getOrCreateInstance(modalElement).hide();
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    initFileExplorerEvents();
});
