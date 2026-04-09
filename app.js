require('dotenv').config();

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const homeRoutes = require('./src/routes/routes');
const sonarScannerController = require('./src/controllers/sonar/sonarScannerController');
const gitleaksScannerController = require('./src/controllers/gitleaks/gitleaksScannerController');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'src/public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));

// Favicon específico
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'src/public/favicon.ico'));
});

app.use('/', homeRoutes);

const server = http.createServer(app);
const scannerWss = sonarScannerController.initScannerWebSocket(server);
const gitleaksWss = gitleaksScannerController.initGitleaksWebSocket(server);

server.on('upgrade', function(request, socket, head) {
	const host = request.headers.host || 'localhost';
	const requestUrl = new URL(request.url || '', `http://${host}`);

	if (requestUrl.pathname === '/ws/scanner') {
		scannerWss.handleUpgrade(request, socket, head, function(ws) {
			scannerWss.emit('connection', ws, request);
		});
		return;
	}

	if (requestUrl.pathname === '/ws/gitleaks') {
		gitleaksWss.handleUpgrade(request, socket, head, function(ws) {
			gitleaksWss.emit('connection', ws, request);
		});
		return;
	}

	socket.destroy();
});

server.listen(PORT);
