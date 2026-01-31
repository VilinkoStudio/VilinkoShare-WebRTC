window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => console.log('WS: server connected (服务器已连接)');
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        console.log('WS:', msg);
        switch (msg.type) {
            case 'peers':
                Events.fire('peers', msg.peers);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'keepalive-timeout':
                console.warn('RTC: Keepalive 被触发');
                break;
            case 'display-name':
                Events.fire('display-name', msg);
                break;
            default:
                console.error('WS: unkown message type (未知消息类型)', msg);
        }
    }

    send(message) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        // 在开发环境中，WebSocket服务器运行在3000端口
        const host = location.hostname + ':3000';
        const url = protocol + '://' + host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
    }

    _onDisconnect() {
        console.log('WS: server disconnected (服务器已断开)');
        Events.fire('notify-user', '连接已断开，5秒后重试...');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }
}

class Peer {

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._busy = false;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        for (let i = 0; i < files.length; i++) {
            this._filesQueue.push(files[i]);
        }
        if (this._busy) return;
        this._dequeueFile();
    }

    _dequeueFile() {
        if (!this._filesQueue.length) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    _sendFile(file) {
        console.log('RTC: sending file (正在发送文件):', file.name, 'size:', file.size);
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size
        });
        this._chunker = new FileChunker(file,
            chunk => this._send(chunk),
            offset => this._onPartitionEnd(offset));
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd()) return;
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            console.log('RTC: received binary chunk (收到二进制数据块), size:', message.length);
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC: received message type (收到消息类型):', message.type, 'from:', this._peerId);
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition-received':
                this._sendNextPartition();
                break;
            case 'progress':
                this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted();
                break;
            case 'text':
                this._onTextReceived(message);
                break;
        }
    }

    _onFileHeader(header) {
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength) return;
        
        this._digester.unchunk(chunk);
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress 
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        Events.fire('file-progress', { sender: this._peerId, progress: progress });
    }

    _onFileReceived(proxyFile) {
        Events.fire('file-received', proxyFile);
        this.sendJSON({ type: 'transfer-complete' });
    }

    _onTransferCompleted() {
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        this._dequeueFile();
        Events.fire('notify-user', '文件传输完成');
    }

    sendText(text) {
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        this.sendJSON({ type: 'text', text: unescaped });
    }

    _onTextReceived(message) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        Events.fire('text-received', { text: escaped, sender: this._peerId });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        if (!this._conn) this._openConnection(peerId, isCaller);

        if (isCaller) {
            this._openChannel();
        } else {
            this._conn.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _openConnection(peerId, isCaller) {
        this._isCaller = isCaller;
        this._peerId = peerId;
        console.log('RTC: opening connection to (正在建立连接到)', peerId, 'as caller (作为呼叫方):', isCaller);
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
        this._conn.onsignalingstatechange = e => {
            console.log('RTC: signaling state changed to (信令状态已变更为)', this._conn.signalingState);
        };
    }

    _openChannel() {
        console.log('RTC: creating data channel for (正在为以下用户创建数据通道)', this._peerId);
        try {
            const channel = this._conn.createDataChannel('data-channel', { 
                ordered: true,
                reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
            });
            channel.onopen = e => {
                console.log('RTC: data channel opened for (数据通道已打开)', this._peerId);
                this._onChannelOpened(e);
            };
            channel.onerror = e => {
                console.error('RTC: data channel error (数据通道错误):', e);
                console.error('RTC: channel state (通道状态):', channel.readyState);
                console.error('RTC: connection state (连接状态):', this._conn?.connectionState);
                console.error('RTC: ICE connection state (ICE连接状态):', this._conn?.iceConnectionState);
                
                if (this._isCaller && this._conn?.connectionState === 'connected' && this._conn?.iceConnectionState === 'connected' && channel.readyState === 'closed') {
                    console.log('RTC: ignoring channel error, connection is healthy (忽略通道错误，连接健康)');
                    return;
                }
                
                if (this._isCaller) {
                    console.log('RTC: attempting to reconnect as caller (尝试作为呼叫方重新连接)');
                    setTimeout(() => {
                        if (this._channel?.readyState !== 'open') {
                            this._connect(this._peerId, true);
                        }
                    }, 1000);
                }
            };
            channel.onclose = e => {
                console.log('RTC: data channel closed (数据通道已关闭):', e);
            };
            this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
        } catch (e) {
            console.error('RTC: failed to create data channel (创建数据通道失败):', e);
            this._onError(e);
        }
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        console.log('RTC: setting local description, type (设置本地描述, 类型):', description.type);
        if (!this._conn) {
            console.error('RTC: connection is null, cannot set local description (连接为空，无法设置本地描述)');
            return;
        }
        this._conn.setLocalDescription(description)
            .then(_ => {
                console.log('RTC: local description set, sending signal (本地描述已设置，正在发送信号)');
                this._sendSignal({ sdp: description });
            })
            .catch(e => {
                console.error('RTC: failed to set local description (设置本地描述失败):', e);
                this._onError(e);
            });
    }

    _onIceCandidate(event) {
        if (!event.candidate) return;
        this._sendSignal({ ice: event.candidate });
    }

    onServerMessage(message) {
        console.log('RTC: received server message from (收到服务器消息来自)', message.sender, 'has sdp (包含SDP):', !!message.sdp, 'has ice (包含ICE):', !!message.ice);
        if (!this._conn) {
            console.log('RTC: no connection, opening as receiver (无连接，作为接收方打开)');
            this._connect(message.sender, false);
        }

        if (message.sdp) {
            const remoteDescription = new RTCSessionDescription(message.sdp);
            console.log('RTC: received sdp, type (收到SDP, 类型):', message.sdp.type, 'current state (当前状态):', this._conn.signalingState);
            if (this._conn.signalingState !== 'stable') {
                this._conn.setRemoteDescription(remoteDescription)
                    .then( _ => {
                        console.log('RTC: remote description set (远程描述已设置)');
                        if (message.sdp.type === 'offer') {
                            console.log('RTC: creating answer (创建应答)');
                            return this._conn.createAnswer()
                                .then(d => this._onDescription(d));
                        }
                    })
                    .catch(e => this._onError(e));
            } else {
                console.log('RTC: ignoring sdp, already in stable state (忽略SDP，已处于稳定状态)');
            }
        } else if (message.ice) {
            if (this._conn.remoteDescription) {
                console.log('RTC: adding ICE candidate (添加ICE候选)');
                this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
            } else {
                console.log('RTC: ignoring ICE candidate, no remote description (忽略ICE候选，无远程描述)');
            }
        }
    }

    _onChannelOpened(event) {
        console.log('RTC: channel opened with (通道已打开)', this._peerId);
        const channel = event.channel || event.target;
        
        if (!channel || channel.readyState !== 'open') {
            console.error('RTC: invalid channel state (无效的通道状态):', channel?.readyState);
            return;
        }
        
        if (this._channel && this._channel !== channel) {
            console.log('RTC: cleaning up old channel (清理旧通道)');
            this._channel.onmessage = null;
            this._channel.onclose = null;
        }
        
        channel.binaryType = 'arraybuffer';
        channel.onmessage = e => {
            console.log('RTC: message received from (收到消息来自)', this._peerId, 'size:', e.data.length);
            this._onMessage(e.data);
        };
        channel.onclose = e => {
            console.log('RTC: channel closing with (通道正在关闭)', this._peerId);
            this._onChannelClosed();
        };
        this._channel = channel;
        console.log('RTC: channel readyState (通道就绪状态):', channel.readyState);
    }

    _onChannelClosed() {
        console.log('RTC: channel closed (通道已关闭)', this._peerId);
        if (!this._isCaller) return;
        this._connect(this._peerId, true); // reopen
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed (状态已变更为):', this._conn.connectionState);
        switch (this._conn.connectionState) {
            case 'disconnected':
                this._onChannelClosed();
                break;
            case 'failed':
                if (this._conn) {
                    this._conn.close();
                }
                this._conn = null;
                this._channel = null;
                this._onChannelClosed();
                break;
            case 'closed':
                this._conn = null;
                this._channel = null;
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE Gathering failed (ICE收集失败)');
                break;
            default:
                console.log('ICE Gathering (ICE收集状态)', this._conn.iceConnectionState);
        }
    }

    _onError(error) {
        console.error(error);
    }

    _send(message) {
        if (!this._channel) {
            console.error('RTC: channel not ready, attempting refresh (通道未就绪，尝试刷新)');
            Events.fire('notify-user', '通道未就绪，请尝试刷新（双端刷新）');
            this.refresh();
            return;
        }
        if (this._channel.readyState !== 'open') {
            console.error('RTC: channel not open, state (通道未打开, 状态):', this._channel.readyState, 'attempting refresh (尝试刷新)');
            Events.fire('notify-user', '通道未就绪，请尝试刷新（双端刷新）');
            this.refresh();
            return;
        }
        try {
            this._channel.send(message);
        } catch (e) {
            console.error('RTC: send failed (发送失败):', e);
            this.refresh();
        }
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        this._server.send(signal);
    }

    refresh() {
        // check if channel is open. otherwise create one
        if (this._isConnected() || this._isConnecting()) return;
        if (!this._peerId) {
            console.log('RTC: refresh called but no peerId yet (调用刷新但还没有peerId)');
            return;
        }
        console.log('RTC: refresh called, connecting as caller (调用刷新，作为呼叫方连接)');
        this._connect(this._peerId, true);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    _isConnecting() {
        return this._channel && this._channel.readyState === 'connecting';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('peer-joined', e => this._onPeerJoined(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            console.log('PeersManager: received signal from unknown peer, creating RTCPeer (收到来自未知节点的信号，创建RTCPeer)');
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                console.log('PeersManager: creating RTCPeer for (为以下用户创建RTCPeer)', peer.id, 'without connecting (不进行连接)');
                this.peers[peer.id] = new RTCPeer(this._server, peer.id);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        console.log('PeersManager: files-selected received, to (文件选择已接收，发送到):', message.to, 'files:', message.files.length);
        if (!this.peers[message.to]) {
            console.error('PeersManager: peer not found (未找到节点):', message.to);
            return;
        }
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        if (!peer) return;
        if (peer._peer) {
            peer._peer.close();
        }
        delete this.peers[peerId];
    }

    _onPeerJoined(peer) {
        if (this.peers[peer.id]) {
            console.log('PeersManager: peer already exists, refreshing (节点已存在，正在刷新)');
            this.peers[peer.id].refresh();
            return;
        }
        if (window.isRtcSupported && peer.rtcSupported) {
            console.log('PeersManager: creating RTCPeer for', peer.id);
            this.peers[peer.id] = new RTCPeer(this._server, peer.id);
        } else {
            this.peers[peer.id] = new WSPeer(this._server, peer.id);
        }
    }
}

class WSPeer {
    _send(message) {
        message.to = this._peerId;
        this._server.send(message);
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000; // 64 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) return;
        if (this._isPartitionEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        let blob = new Blob(this._buffer, { type: this._mime });
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            blob: blob
        });
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static off(type, callback) {
        return window.removeEventListener(type, callback, false);
    }
}


RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        {
            urls: 'stun:stun.l.google.com:19302'
        },
        {
            urls: 'stun:stun1.l.google.com:19302'
        },
        {
            urls: 'stun:stun2.l.google.com:19302'
        }
    ]
}
