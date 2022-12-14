const net = require('net');

const numberToHex = num => {
  return Number(`0x${Number(num).toString(16)}`);
};
const ERROR_MAP = {
  1: '代理服务器故障',
  2: '代理服务器规则集不允许连接',
  3: '网络无法访问',
  4: '目标服务器无法访问（主机名无效）',
  5: '连接目标服务器被拒绝',
  6: 'TTL已过期',
  7: '不支持的命令',
  8: '不支持的目标服务器地址类型',
};

class Socket extends net.Socket {
  constructor(opts = {}) {
    super(opts);
    const { proxy = {} } = opts;
    if (!proxy || !proxy.host) return;
    const { port = 1080, host = '', userId = '', password = '', type = 'socks5' } = proxy;
    if (userId && !password) throw new Error('You need to pass the password params.');
    this.proxy = proxy;
    this.proxyHost = host;
    this.proxyPort = port;
    this.proxyUsername = userId;
    this.proxyPassword = password;
    this.proxyType = type;
    if (!['socks5', 'http'].includes(type)) throw new Error(`Not support proxy type: ${type}`);
    this.isConnected = false;

    const _on = this.on;
    this._on = _on;

    this.on = (name, listener) => {
      const isTmp = !!name.match('_tmp');
      _on.call(this, name.replace('_tmp', ''), (...args) => {
        if (this.isConnected) {
          listener.apply(this, args);
        } else if (isTmp) {
          listener.apply(this, args);
        } else if (name === 'connect') {
          listener.apply(this, args);
        }
      });
    };
  }

  async connect(opts = {}, listener) {
    if (!this.proxy) {
      // eslint-disable-next-line
      super.connect.apply(this, arguments);
      return;
    }
    if (this.proxyType === 'socks5') {
      await this.connectSocks(opts, listener);
    } else {
      await this.connnectHttp(opts, listener);
    }
    this.on = this._on;
    this.isConnected = true;
    console.log('Socket proxy connect success.');
  }

  async connnectHttp(opts = {}, listener) {
    const targetHost = opts.host;
    const targetPort = opts.port;

    return new Promise((resolve, reject) => {
      console.debug(
        'Start connect target: ',
        `${this.proxyType}://${this.proxyPort}:${this.proxyHost}`,
        this.proxyUsername,
        this.proxyPassword
      );
      super.connect({
        port: this.proxyPort,
        host: this.proxyHost,
      });
      this.once('connect_tmp', () => {
        console.debug('Send Connect method.');
        this.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`);
        this.write('Connection: keep-alive\r\n');
        this.write('Content-Length: 0\r\n');
        if (this.proxyUsername) {
          const base64 = Buffer.from(`${this.proxyUsername}:${this.proxyPassword}`).toString(
            'base64'
          );
          this.write(`Proxy-Authorization: Basic ${base64}\r\n`);
        }
        this.write('\r\n');
        this.once('data_tmp', data => {
          const str = String(data.toString()).trim();
          console.debug(`Recv Connect method: ${str}`);
          if (!str.match(/^HTTP\/1\.1 200/i)) {
            return reject(new Error(str));
          }
          if (typeof listener === 'function') listener();
          console.debug('Connnect socket success.');
          resolve();
        });
      });
    });
  }

  async connectSocks(opts = {}, listener) {
    const host = this.proxyHost || opts.host;
    const port = this.proxyPort || opts.port;
    const params = { ...opts, host, port };

    return new Promise((resolve, reject) => {
      if (this.proxyHost) {
        console.debug('Start connect proxy: ', `${this.proxyType}://${host}:${port}`);
      } else {
        console.debug('Start connect target: ', `${host}:${port}`);
      }
      super.connect(params);
      this.once('connect_tmp', async () => {
        if (this.proxyHost) {
          console.debug(`Connect proxy success:`, ` ${this.proxyType}://${host}:${port}`);
        } else {
          console.debug('Connect target success: ', `${host}:${port}`);
        }
        try {
          await this.auth();
          await this.connectTarget(opts);
          if (typeof listener === 'function') listener();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async auth() {
    if (!this.proxyHost) return; // 不需要代理
    /** 第一位 socks 版本，固定 0x05
    // 第二位，支持的验证方法数量，默认支持无密码和有密码两种
    // 第三第四位，
    0x00 不需要认证（常用）
    0x01 GSSAPI认证
    0x02 账号密码认证（常用）
    0x03 - 0x7F IANA分配
    0x80 - 0xFE 私有方法保留
    0xFF 无支持的认证方法
    */
    return new Promise((resolve, reject) => {
      const head = Buffer.from([0x05, 0x02, 0x00, 0x02]);
      this.write(head);
      this.once('data_tmp', data => {
        if (data.length !== 2) {
          return reject(new Error('Unexpected number of bytes received.'));
        }
        if (data[0] !== 0x05) {
          return reject(new Error(`Unexpected socks version number: ${data[0]}.`));
        }
        const authType = data[1];
        if (authType !== 0x00 && authType !== 0x02)
          return reject(new Error(`Unexpected socks authentication method: ${authType}`));
        if (authType === 0x00) {
          console.debug('Not need auth.');
          return resolve();
        }
        console.debug('Use auth: ', this.proxyUsername, this.proxyPassword);
        const bUsername = Buffer.from(this.proxyUsername);
        let bUser = Buffer.concat([Buffer.from([0x01, bUsername.length]), bUsername]);
        const bPassword = Buffer.from(this.proxyPassword);
        bUser = Buffer.concat([bUser, Buffer.from([bPassword.length]), bPassword]);
        this.write(bUser);

        this.once('data_tmp', authData => {
          if (authData.length !== 2)
            return reject(new Error('Unexpected number of bytes received.'));
          if (authData[0] !== 0x01)
            return reject(new Error(`Unexpected authentication method code: ${authData[0]}.`));
          if (authData[1] !== 0x00)
            return reject(
              new Error(`Username and password authentication failure: ${authData[1]}.`)
            );
          resolve();
        });
      });
    });
  }

  async connectTarget(opts = {}) {
    if (!this.proxyHost) return; // 不需要代理
    const { host, port } = opts;
    return new Promise((resolve, reject) => {
      let buffer = Buffer.from([0x05, 0x01, 0x00]);
      const targetType = net.isIP(host);
      let hexPort = Number(port).toString(16);
      if (hexPort.length < 4) {
        hexPort = new Array(4 - hexPort.length + 1).join('0') + hexPort;
      }
      if (targetType === 4) {
        buffer = Buffer.concat([
          buffer,
          Buffer.from([0x01]),
          Buffer.from(host.split('.').map(num => numberToHex(num))),
          Buffer.from([Number(`0x${hexPort.substr(0, 2)}`), Number(`0x${hexPort.substr(2)}`)]),
        ]);
      } else if (targetType === 0) {
        const bufferHost = Buffer.from(host);
        buffer = Buffer.concat([
          buffer,
          Buffer.from([0x03, bufferHost.length]),
          bufferHost,
          Buffer.from([Number(`0x${hexPort.substr(0, 2)}`), Number(`0x${hexPort.substr(2)}`)]),
        ]);
      }
      console.debug('Connnect socket target: ', `${host}:${port}`);
      this.write(buffer);
      this.once('data_tmp', data => {
        const version = data[0];
        if (version !== 0x05)
          return reject(new Error(`Unexpected SOCKS version number: ${version}.`));
        const response = data[1];
        if (response !== 0x00) {
          if (ERROR_MAP[response]) return reject(new Error(ERROR_MAP[response]));
          return reject(new Error('Unknown error'));
        }
        resolve();
      });
    });
  }
}

module.exports = Socket;
