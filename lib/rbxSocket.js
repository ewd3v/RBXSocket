"use strict";

const EventEmitter = require("events");

const socketMap = require("./socketMap");
const readRequestData = require("./readRequestData");
const safeParse = require("./safeParse");

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class RBXSocket extends EventEmitter {
  constructor(socketId, options) {
    super();

    this._buffer = [];
    this._bufferTimeout = null;
    this._connectionQueue = [];
    this._closeCode = undefined;
    this._closeReason = undefined;

    this.options = options;
    this.state = OPEN;
    this.socketId = socketId;
    socketMap.set(socketId, this);
  }

  async handlePoll(req, res) {
    if (this.state == CLOSED) {
      return res.destroy();
    }

    const data = await readRequestData(req);
    const body = safeParse(data.toString("utf-8"));
    if (body) {
      for (const data of body) {
        this.emit("message", data);
      }
    }

    if (this.state === CLOSING) {
      res
        .writeHead(410, {
          "Close-Code": this._closeCode || 1000,
          "Close-Reason": this._closeReason,
        })
        .end(JSON.stringify(this._buffer));
      this._buffer.length = 0;

      return this.terminate();
    }

    if (this._buffer.length > 0 && !this._bufferTimeout) {
      res.end(JSON.stringify(this._buffer));
      this._buffer.length = 0;

      return;
    }

    this._connectionQueue.push(res);
    if (this._connectionQueue.length > this.options.maxConnectionPoolSize) {
      const connection = this._connectionQueue.shift();
      if (!connection) return; // Strange, shouldn't happen.

      connection.end("[]");
    }

    res.on("end", () => {
      const index = this._connectionQueue.findIndex(
        (connection) => connection === res
      );
      if (index < 0) return; // Did not find in the queue, if it's not there we don't need to remove it.

      this._connectionQueue.splice(index, 1);
    });
  }

  send(data) {
    this._buffer.push(data);
    if (this._bufferTimeout) return;

    this._bufferTimeout = setTimeout(() => {
      this._bufferTimeout = null;

      const connection = this._connectionQueue.shift();
      if (!connection) return;

      connection.end(JSON.stringify(this._buffer));
      this._buffer.length = 0;
    }, this.options.bufferTime * 1000);
  }

  close(code = 1000, reason) {
    if (this.state === CLOSING || this.state === CLOSED) return;
    this.state = CLOSING;

    this._closeCode = code;
    this._closeReason = reason;
    this.emit("close", code, reason);

    const connection = this._connectionQueue.shift();
    if (!connection) return;

    connection
      .writeHead(410, {
        "Close-Code": code,
        "Close-Reason": reason,
      })
      .end(JSON.stringify(this._buffer));
    this._buffer.length = 0;

    this.terminate();
  }

  terminate() {
    if (this.state === OPEN) this.emit("close", 1000, "socket was terminated");
    this.state = CLOSED;
    socketMap.delete(this.socketId);

    if (this._bufferTimeout) clearTimeout(this._bufferTimeout);
    for (const connection of this._connectionQueue) {
      connection.destroy();
    }
  }
}

module.exports = RBXSocket;
