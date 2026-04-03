require('dotenv').config();

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const homeRoutes = require('./src/routes/homeRoutes');
const scannerController = require('./src/controllers/scannerController');
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'src/public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use('/', homeRoutes);

const server = http.createServer(app);
scannerController.initScannerWebSocket(server);

server.listen(PORT);
