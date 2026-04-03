const fs = require('node:fs/promises');
const path = require('node:path');

const BASE_DIR = '/workspace/';
const BASE_DIR_RESOLVED = path.resolve(BASE_DIR);

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function resolveSafePath(rawRelativePath) {
  const sanitizedRelativePath = String(rawRelativePath || '').trim();
  const pathSegments = toPosixPath(sanitizedRelativePath)
    .split('/')
    .filter(Boolean);

  const hasHiddenSegment = pathSegments.some(function(segment) {
    return segment.startsWith('.');
  });

  if (hasHiddenSegment) {
    const error = new Error('Ruta oculta no permitida.');
    error.code = 'INVALID_PATH';
    throw error;
  }

  const resolvedPath = path.resolve(BASE_DIR_RESOLVED, sanitizedRelativePath || '.');

  const isInsideBaseDir = resolvedPath === BASE_DIR_RESOLVED
    || resolvedPath.startsWith(`${BASE_DIR_RESOLVED}${path.sep}`);

  if (!isInsideBaseDir) {
    const error = new Error('Ruta fuera del directorio permitido.');
    error.code = 'INVALID_PATH';
    throw error;
  }

  const relativePath = path.relative(BASE_DIR_RESOLVED, resolvedPath);
  return {
    absolutePath: resolvedPath,
    relativePath: relativePath ? toPosixPath(relativePath) : ''
  };
}

async function readDirectoryItems(absolutePath) {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  return entries
    .filter(function(entry) {
      return !entry.name.startsWith('.');
    })
    .map(function(entry) {
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'file'
      };
    })
    .sort(function(a, b) {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    });
}

async function renderExplorer(req, res) {
  try {
    const requestedPath = req.body?.path || '';
    const { absolutePath, relativePath } = resolveSafePath(requestedPath);
    const items = await readDirectoryItems(absolutePath);

    return res.render('partials/fileExplorerView', {
      path: relativePath,
      items,
      error: null
    });
  } catch (error) {
    if (error?.code === 'INVALID_PATH') {
      return res.status(400).render('partials/fileExplorerView', {
        path: '',
        items: [],
        error: 'Ruta inválida.'
      });
    }

    return res.status(500).render('partials/fileExplorerView', {
      path: '',
      items: [],
      error: 'No fue posible cargar el explorador de archivos.'
    });
  }
}

async function listFiles(req, res) {
  try {
    const requestedPath = req.body?.path || '';
    const { absolutePath, relativePath } = resolveSafePath(requestedPath);
    const items = await readDirectoryItems(absolutePath);

    return res.json({
      path: relativePath,
      items
    });
  } catch (error) {
    if (error?.code === 'INVALID_PATH') {
      return res.status(400).json({ message: 'Ruta inválida.' });
    }

    return res.status(500).json({ message: 'No fue posible listar el contenido de la carpeta.' });
  }
}

module.exports = {
  renderExplorer,
  listFiles
};
