# 部署文档

## 环境要求

- Node.js >= 14
- npm 或 pnpm
- Nginx >= 1.18
- PM2 >= 4.0

> [!WARNING]  
> 原项目为 Snapdrop ，本项目在后端未做大面积更改。前端修复了多端适配和在鸿蒙设备上的兼容性问题，服务端添加了更多检查点。


## 本地开发

```bash
cd server && npm install && node index.js
cd client && npx http-server -p 8080
```

## Docker 部署

```bash
docker-compose up -d
```

访问地址：
- HTTP: http://localhost:8080
- HTTPS: https://localhost:443

### 配置域名

编辑 `docker/fqdn.env`:
```env
FQDN=your-domain.com
```

编辑 `docker/nginx/default.conf`:
```nginx
server {
    listen       80;
    server_name  your-domain.com;
    
    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    location /server {
        proxy_pass http://node:3000;
        proxy_set_header Connection "upgrade";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header X-Forwarded-for $remote_addr;
    }
}
```

### SSL 证书

将证书文件放入 `docker/certs/` 目录，修改 `docker/nginx/default.conf`:
```nginx
ssl_certificate /etc/ssl/certs/your-cert.crt;
ssl_certificate_key /etc/ssl/certs/your-key.key;
```

### 常用命令

```bash
docker-compose up -d
docker-compose down
docker-compose logs -f
docker-compose logs node
docker-compose logs nginx
```

## 生产环境部署

### 1. 上传代码

```bash
scp -r . user@server:/var/www/vilinko-share
ssh user@server
```

### 2. 安装依赖

```bash
cd /var/www/vilinko-share/server
npm install --production
```

### 3. 配置 Nginx

创建 `/etc/nginx/sites-available/vilinko-share`:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/ssl/certs/your-cert.crt;
    ssl_certificate_key /etc/ssl/certs/your-key.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        root /var/www/vilinko-share/client;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /server {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
    gzip_min_length 1000;
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/vilinko-share /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. 启动服务（PM2）

```bash
cd /var/www/vilinko-share/server
npm install -g pm2
pm2 start index.js --name vilinko-share
pm2 save
pm2 startup
```

查看状态：

```bash
pm2 status
pm2 logs vilinko-share
pm2 restart vilinko-share
pm2 stop vilinko-share
pm2 delete vilinko-share
```

### 5. 启动服务（Systemd）

创建 `/etc/systemd/system/vilinko-share.service`:

```ini
[Unit]
Description=VilinkoShare WebSocket Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/vilinko-share/server
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=vilinko-share

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable vilinko-share
sudo systemctl start vilinko-share
sudo systemctl status vilinko-share
sudo systemctl restart vilinko-share
sudo systemctl stop vilinko-share
```

查看日志：

```bash
sudo journalctl -u vilinko-share -f
```

## 配置项

### WebSocket 端口

编辑 `server/index.js`，修改构造函数参数：

```javascript
constructor(port) {
    const WebSocket = require('ws');
    this._wss = new WebSocket.Server({ port: port });
}
```

启动时指定端口：

```bash
node index.js 3000
````

### 设备名称生成

编辑 `server/index.js` 中的 displayName 生成逻辑：

```javascript
const displayName = uniqueNamesGenerator({
    length: 1,
    separator: ' ',
    dictionaries: [colors],
    style: 'capital',
    seed: this.id.hashCode()
});
```

可用字典：
- `colors` - 颜色
- `animals` - 动物
- `adjectives` - 形容词
- `names` - 名字

## 故障排查

### WebSocket 连接失败

检查服务器状态：

```bash
pm2 status vilinko-share
netstat -tlnp | grep 3000
```

检查 Nginx 配置：

```bash
sudo nginx -t
sudo systemctl status nginx
```

检查防火墙：

```bash
sudo ufw status
sudo ufw allow 3000
sudo ufw allow 80
sudo ufw allow 443
```

### 文件传输失败

检查浏览器控制台，确认 WebRTC 支持：

```javascript
console.log('WebRTC supported:', !!window.RTCPeerConnection);
```

检查网络连接，需要 STUN/TURN 服务器用于 NAT 穿透。

### PWA 安装失败

确认 HTTPS 已启用（localhost 除外）。

检查 manifest.json：

```bash
curl -I https://your-domain.com/manifest.json
```

检查 Service Worker：

```javascript
navigator.serviceWorker.getRegistrations().then(console.log);
```

## 安全配置

### 防火墙

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
// sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### SSL 证书（Let's Encrypt）

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
sudo certbot renew --dry-run
```

自动续期：

```bash
sudo crontab -e
```

添加：

```
0 0 * * * certbot renew --quiet
```

### Nginx 安全配置

在 `server` 块中添加：

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://* ws://*;" always;
```

## 监控

### PM2 监控

```bash
pm2 monit
pm2 plus
```

### 日志轮转

创建 `/etc/logrotate.d/vilinko-share`:

```
/home/user/.pm2/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

## 性能优化

### Node.js 优化

启动时添加参数：

```bash
node --max-old-space-size=4096 index.js
```

### Nginx 缓存

在 `server` 块中添加：

```nginx
location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## 更新部署

```bash
cd /var/www/vilinko-share
git pull
cd server && npm install --production
pm2 restart vilinko-share
```

## 回滚

```bash
cd /var/www/vilinko-share
git log --oneline
git checkout <commit-hash>
cd server && npm install --production
pm2 restart vilinko-share
```
