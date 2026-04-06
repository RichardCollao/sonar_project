const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_MODULES_DIR = path.join(ROOT_DIR, 'node_modules');
const PUBLIC_VENDOR_DIR = path.join(ROOT_DIR, 'src', 'public', 'vendor');

const assetsToCopy = [
  {
    from: path.join(NODE_MODULES_DIR, 'bootstrap', 'dist'),
    to: path.join(PUBLIC_VENDOR_DIR, 'bootstrap')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'bootstrap-icons', 'font'),
    to: path.join(PUBLIC_VENDOR_DIR, 'bootstrap-icons', 'font')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'jquery', 'dist'),
    to: path.join(PUBLIC_VENDOR_DIR, 'jquery')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'datatables.net', 'js'),
    to: path.join(PUBLIC_VENDOR_DIR, 'datatables.net', 'js')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'datatables.net-bs5', 'css'),
    to: path.join(PUBLIC_VENDOR_DIR, 'datatables.net-bs5', 'css')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'datatables.net-bs5', 'js'),
    to: path.join(PUBLIC_VENDOR_DIR, 'datatables.net-bs5', 'js')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'sweetalert2', 'dist'),
    to: path.join(PUBLIC_VENDOR_DIR, 'sweetalert2')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'izitoast', 'dist'),
    to: path.join(PUBLIC_VENDOR_DIR, 'izitoast')
  },
  {
    from: path.join(NODE_MODULES_DIR, '@xterm', 'addon-fit', 'lib'),
    to: path.join(PUBLIC_VENDOR_DIR, 'xterm-addon-fit', 'lib')
  },
  {
    from: path.join(NODE_MODULES_DIR, 'jspdf', 'dist'),
    to: path.join(PUBLIC_VENDOR_DIR, 'jspdf')
  }
];

async function copyDirectory(from, to) {
  await fs.access(from);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, force: true });
}

async function run() {
  await fs.mkdir(PUBLIC_VENDOR_DIR, { recursive: true });

  for (const asset of assetsToCopy) {
    await copyDirectory(asset.from, asset.to);
  }

  console.log('Librerías copiadas a src/public/vendor correctamente.');
}

(async function main() {
  try {
    await run();
  } catch (error) {
    console.error('Error copiando librerías a public/vendor:', error.message);
    process.exitCode = 1;
  }
})();
