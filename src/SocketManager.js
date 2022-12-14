const net = require('net');
const WhatsApp = require('./Whatsapp');
const SocketClient = require('./SocketClient');
const db = require('./db');
const WASocketClient = require('./WASocketClient');
const config = require('./config');

class SocketManager {
  constructor() {
    this.id = 0;

    this.sockets = {}; // 客户端 socket
    this.wasockets = {}; // whatsapp 服务器 socket

    // 缓存 uid aeskey
    this.uidObject = {};
  }

  async getClientAESKeyByUID(uid) {
    if (this.uidObject[uid]) return this.uidObject[uid];
    const user = await db.business.findOne({ uid });
    if (!user) return '';

    this.uidObject[uid] = user.aesKey;
    return this.uidObject[uid];
  }

  async initServer(port) {
    const server = net.createServer(socket => {
      this.addSocketClient(socket);
    });
    server.listen(port, () => {
      console.info(`The socket server bound on port ${port}.`);
    });
    server.on('error', e => {
      console.error('socket server on error', e);
    });
    server.on('close', () => {
      console.info('socket server on closed.');
    });
    server.maxConnections = 60000;

    this.server = server;
  }

  async initWASocket(opts, account) {
    this.id++;
    const { mobile, cc, mnc, mcc, proxy } = opts;
    const socketName = `Socket_${this.id}`;

    const waSocketClient = new WASocketClient(
      {
        ...opts,
        socketName,
        endpoint: config.getEndPoint(),
        account,
      },
      this
    );

    waSocketClient.on('destroy', name => {
      this.destroy(name);
    });

    this.wasockets[socketName] = waSocketClient;
    return socketName;
  }

  getWASocketClient(socketName) {
    return this.wasockets[socketName];
  }

  async addSocketClient(socket) {
    this.id++;
    const socketName = `Socket_${this.id}`;

    // 新增一个客户端实例
    const socketClient = new SocketClient(
      {
        socket,
        socketName,
        isUseBufferLength: config.isUseBufferLength,
      },
      this
    );
    await socketClient.init();
    this.sockets[socketName] = socketClient;

    // 一个 wa 对象对应一个 client
    const whatsapp = new WhatsApp({ isUseSocket: true, client: socketClient, socketName });
    this.wa[socketName] = whatsapp;
  }

  async destroy(socketName) {
    console.info('destroy sockets', socketName);
    if (this.sockets[socketName]) this.sockets[socketName].destroy();
    this.sockets[socketName] = null;

    if (this.wasockets[socketName]) this.wasockets[socketName].destroy();
    this.wasockets[socketName] = null;
  }

  exec(socketName, cmd, params) {
    return this.wa[socketName][cmd](params);
  }
}

module.exports = SocketManager;
