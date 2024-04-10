"use strict";

const EventEmitter = require("events");
const http = require("http");
const { randomBytes } = require("crypto");

const RBXSocket = require("./rbxSocket");
const socketMap = require("./socketMap");

const RUNNING = 0;
const CLOSING = 1;
const CLOSED = 2;

const addListeners = (server, map) => {
  for (const event of Object.keys(map)) server.on(event, map[event]);

  return () => {
    for (const event of Object.keys(map))
      server.removeListener(event, map[event]);
  };
};

const emitClose = (server) => {
  server._state = CLOSED;
  server.emit("close");
};

class RBXSocketServer extends EventEmitter {
  constructor(options) {
    super();

    options = {
      maxConnectionPoolSize: 2,
      bufferTime: 0,
      allowClientIds: false,
      noServer: false,
      server: null,
      port: null,
      host: null,
      path: "/",
      clientTracking: true,
      ...options,
    };

    if (options.maxConnectionPoolSize > 2)
      console.warn(
        "It is not reccomended to set maxConnectionPoolSize to a value greater than 2 (Roblox likes to not send requests when there are already 3 being sent)."
      );

    if (
      (options.port == null && !options.server && !options.noServer) ||
      (options.port != null && (options.server || options.noServer)) ||
      (options.server && options.noServer)
    ) {
      throw new TypeError(
        'One and only one of the "port", "server", or "noServer" options must be specified'
      );
    }

    if (options.port !== null) {
      this._server = http.createServer();
      this._server.listen(options.port, options.host);
    } else if (options.server) {
      this._server = options.server;
    }

    if (this._server) {
      this._removeListeners = addListeners(this._server, {
        error: this.emit.bind(this, "error"),
        request: (req, res) => {
          if (req.url !== options.path || this.state !== RUNNING) return;

          switch (req.method) {
            case "HEAD":
              this.handleHandshake(req, res);
              break;
            case "PATCH":
              this.handlePoll(req, res);
              break;
            case "DELETE":
              this.handleClose(req, res);
              break;
          }
        },
      });
    }

    if (options.clientTracking) this.clients = new Set();
    this.options = options;
    this.state = RUNNING;
  }

  close(callback) {
    if (this.state === CLOSED) {
      if (callback) {
        this.once("close", () =>
          callback(new Error("The server is not running"))
        );
      }

      process.nextTick(emitClose, this);

      return;
    }

    if (callback) this.once("close", callback);

    if (this.state === CLOSING) return;
    this.state = CLOSING;

    const server = this._server;
    this._removeListeners();
    this._removeListeners = this._server = null;

    socketMap.forEach((socket) => {
      socket.terminate();
    });

    if (this.options.port) {
      server.close(() => emitClose(this));
    } else {
      process.nextTick(emitClose, this);
    }
  }

  createSocket(req, id) {
    const socket = new RBXSocket(randomBytes(16).toString("hex"), this.options);
    if (this.clients) {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
    }

    this.emit("connection", socket, req);

    return socket;
  }

  handleHandshake(req, res) {
    const socket = this.createSocket(req);
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Socket-Id": socket.socketId,
        "Max-Pool-Size": this.options.maxConnectionPoolSize,
      })
      .end();
  }

  handlePoll(req, res) {
    const socketId = req.headers["socket-id"];
    if (!socketId) return res.writeHead(400).end("Missing Socket-Id");

    let socket = socketMap.get(socketId);
    if (socket) return socket.handlePoll(req, res);
    if (this.options.allowClientIds) {
      return this.createSocket(req, socketId).handlePoll(req, res);
    }

    res.writeHead(404).end("Invalid Socket-Id");
  }

  handleClose(req, res) {
    const socketId = req.headers["socket-id"];
    if (!socketId) return res.writeHead(400).end("Missing Socket-Id");

    const socket = socketMap.get(socketId);
    if (!socket) return res.writeHead(404).end("Invalid Socket-Id");

    const closeCode = Number(req.headers["close-code"]);
    const closeReason = req.headers["close-reason"];

    if (closeCode !== closeCode)
      // Close code is NaN, i.e Number() failed.
      closeCode = 1000;

    socket.state = 2; // CLOSED
    socket.emit("close", closeCode, closeReason);
    socket.terminate();

    res.writeHead(200).end();
  }
}

module.exports = RBXSocketServer;
