const app = { activeRequests: 0 };

function initIziToastDefaults() {
    if (typeof iziToast === 'undefined') return;

    if (typeof iziToast.settings === 'function') {
        iziToast.settings({
            position: 'bottomRight'
        });
    }
}

function showIziToast(type, message) {
    if (typeof iziToast === 'undefined') return false;
    if (typeof iziToast[type] !== 'function') return false;

    iziToast[type]({
        message,
        position: 'bottomRight'
    });

    return true;
}

function iziToastError(message) {
    return showIziToast('error', message);
}

function iziToastSuccess(message) {
    return showIziToast('success', message);
}

function shouldSendBody(method, formData) {
    return (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !!formData;
}

function buildRequestOptions(method, formData) {
    const headers = new Headers();
    const options = { method, headers, mode: "same-origin", credentials: "include", cache: "default" };

    if (!shouldSendBody(method, formData)) {
        return options;
    }

    if (formData instanceof FormData) {
        options.body = formData;
        return options;
    }

    headers.set('Content-Type', 'application/json');
    options.body = typeof formData === 'string' ? formData : JSON.stringify(formData);
    return options;
}

function formatErrorDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    return JSON.stringify(detail);
}

async function parseErrorResponse(res) {
    let errorMessage = `HTTP Error: ${res.status}`;
    let errorDetail = '';

    try {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const errorJson = await res.json();
            errorMessage = errorJson?.message || errorMessage;
            errorDetail = formatErrorDetail(errorJson?.detail);
            return { errorMessage, errorDetail };
        }

        const errorText = await res.text();
        errorDetail = errorText || '';
    } catch {
        // Si no se puede parsear el body, se usa mensaje por defecto.
    }

    return { errorMessage, errorDetail };
}

function showRequestError(errorMessage, errorDetail = '') {
    const text = errorDetail ? `${errorMessage} - ${errorDetail}` : errorMessage;

    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
        Swal.fire({ icon: 'error', title: 'Error', text });
        return;
    }

    if (iziToastError(text)) {
        return;
    }
}

function startLoading() {
    if (app.activeRequests === 0) showLoading();
    app.activeRequests++;
}

function stopLoading() {
    app.activeRequests--;
    if (app.activeRequests === 0) hideLoading();
}

async function request(uri, method = "GET", formData = null, callback = () => { }) {
    startLoading();

    const options = buildRequestOptions(method, formData);
    let json = null;

    try {
        const res = await fetch(uri, options);

        if (!res.ok) {
            const { errorMessage, errorDetail } = await parseErrorResponse(res);
            showRequestError(errorMessage, errorDetail);
            return;
        }

        if (res.status === 204) {
            json = {};
        } else {
            const contentType = res.headers.get('content-type') || '';
            const raw = await res.text();
            const trimmed = raw.trim();

            if (!trimmed) {
                json = {};
            } else if (contentType.includes('application/json')) {
                try {
                    json = JSON.parse(trimmed);
                } catch {
                    throw new Error('La respuesta JSON del servidor es inválida.');
                }
            } else {
                json = { message: trimmed };
            }
        }

        if (json.redirect) {
            location.href = json.redirect;
            return;
        }
    } catch (error) {
        const isNetworkError = error?.name === 'TypeError';

        if (isNetworkError) {
            showRequestError('Error de conexión', 'No fue posible completar la solicitud.');
            return;
        }

        const detail = error?.message || 'No fue posible procesar la respuesta del servidor.';
        showRequestError('Error de respuesta', detail);
        return;
    } finally {
        stopLoading();
    }

    try {
        callback(json);
    } catch (error) {
        const detail = error?.message || 'Se produjo un error ejecutando la respuesta.';
        showRequestError('Error de interfaz', detail);
    }
}

function showLoading() {
    document.getElementById("loading").style.display = "block";
}

function hideLoading() {
    document.getElementById("loading").style.display = "none";
}

initIziToastDefaults();