/**
 * Copyright 2013, 2016 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
	"use strict";
	var ws = require("ws");
	var inspect = require("util").inspect;

	var abortConnection = function(socket) {
		var response;
		try {
			response = ["HTTP/1.1 401 Unauthorized", "Content-type: text/html"];
			return socket.write(response.concat("", "").join("\r\n"));
		} finally {
			try {
				socket.destroy();
			} catch (_error) {
				console.log(_error);
			}
		}
	};

	var upgradeConnection = function(socket) {
		return socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' + 'Upgrade: WebSocket\r\n' + 'Connection: Upgrade\r\n' + '\r\n');
	};

	// A node red node that sets up a local websocket server
	function WebSocketListenerNode(n) {
		// Create a RED node
		RED.nodes.createNode(this, n);
		var node = this;

		// Store local copies of the node configuration (as defined in the .html)
		node.path = n.path;
		node.wholemsg = (n.wholemsg === "true");

		node.role = n.role;
		node.group = n.group;
		node.auth0 = n.auth0;

		node._inputNodes = [];
		// collection of nodes that want to receive events
		node._clients = {};
		// match absolute url
		node.isServer = !/^ws{1,2}:\/\//i.test(node.path);
		node.closing = false;

		function startconn() {// Connect to remote endpoint
			var socket = new ws(node.path);
			node.server = socket;
			// keep for closing
			handleConnection(socket);
		}

		function handleConnection(/*socket*/socket) {
			var id = (1 + Math.random() * 4294967295).toString(16);
			if (node.isServer) {
				node._clients[id] = socket;
				node.emit('opened', Object.keys(node._clients).length);
			}
			socket.on('open', function() {
				if (!node.isServer) {
					node.emit('opened', '');
				}
			});
			socket.on('close', function() {
				if (node.isServer) {
					delete node._clients[id];
					node.emit('closed', Object.keys(node._clients).length);
				} else {
					node.emit('closed');
				}
				if (!node.closing && !node.isServer) {
					node.tout = setTimeout(function() {
						startconn();
					}, 3000);
					// try to reconnect every 3 secs... bit fast ?
				}
			});
			socket.on('message', function(data, flags) {
				node.handleEvent(id, socket, 'message', data, flags);
			});
			socket.on('error', function(err) {
				node.emit('erro');
				if (!node.closing && !node.isServer) {
					node.tout = setTimeout(function() {
						startconn();
					}, 3000);
					// try to reconnect every 3 secs... bit fast ?
				}
			});
		}

		function handleAuthentication(req, socket, head) {
			var authorization,
			    jwtToken,
			    parts,
			    scheme;
			authorization = req.headers.authorization;
			if ( typeof (node.auth0) == "undefined" || !node.auth0) {
				return upgradeConnection(socket);
			}

			if (!authorization) {
				return abortConnection(socket, 400, 'Bad Request');
			}
			parts = authorization.split(" ");
			if (parts.length !== 2) {
				return abortConnection(socket, 400, 'Bad Request');
			}
			scheme = parts[0];
			jwtToken = parts[1];
			if ("Bearer" !== scheme || !jwtToken) {
				return abortConnection(socket, 400, 'Bad Request');
			}

			var request = require('request');
			var options = {
				uri : node.auth0,
				method : 'POST',
				json : {
					id_token : jwtToken
				}
			};
			request(options, function(error, response, body) {
				if (!error && response.statusCode == 200) {
					req.tokeninfo = body || {};
					req.tokeninfo.authorized = true;
					if (node.role && req.tokeninfo && req.tokeninfo.roles && req.tokeninfo.roles.indexOf(node.role) == -1) {
						req.tokeninfo.authorized = false;
					}
					if (node.group && req.tokeninfo && req.tokeninfo.groups && req.tokeninfo.groups.indexOf(node.group) == -1) {
						req.tokeninfo.authorized = false;
					}
					if (req.tokeninfo.authorized) {
						return upgradeConnection(socket);
					} else {
						return abortConnection(socket, 401, 'Unauthorized - HEKKK');
					}
				} else {
					return abortConnection(socket, 503, 'The authentication service is unavailable.');
				}
			});
		}

		if (node.isServer) {
			var path = RED.settings.httpNodeRoot || "/";
			path = path + (path.slice(-1) == "/" ? "" : "/") + (node.path.charAt(0) == "/" ? node.path.substring(1) : node.path);

			// Workaround https://github.com/einaros/ws/pull/253
			// Listen for 'newListener' events from RED.server
			node._serverListeners = {};

			var storeListener = function(/*String*/event, /*function*/listener) {
				if (event == "error" || event == "upgrade" || event == "listening") {
					node._serverListeners[event] = listener;
				}
			};

			RED.server.addListener('newListener', storeListener);

			// Create a WebSocket Server
			node.server = new ws.Server({
				server : RED.server,
				path : path,
				// Disable the deflate option due to this issue
				//  https://github.com/websockets/ws/pull/632
				// that is fixed in the 1.x release of the ws module
				// that we cannot currently pickup as it drops node 0.10 support
				perMessageDeflate : false
			});

			// Workaround https://github.com/einaros/ws/pull/253
			// Stop listening for new listener events
			RED.server.removeListener('newListener', storeListener);

			node.server.on('connection', handleConnection);
			RED.server.on('upgrade', handleAuthentication);
		} else {
			node.closing = false;
			startconn();
			// start outbound connection
		}

		node.on("close", function() {
			// Workaround https://github.com/einaros/ws/pull/253
			// Remove listeners from RED.server
			if (node.isServer) {
				var listener = null;
				for (var event in node._serverListeners) {
					if (node._serverListeners.hasOwnProperty(event)) {
						listener = node._serverListeners[event];
						if ( typeof listener === "function") {
							RED.server.removeListener(event, listener);
						}
					}
				}
				node._serverListeners = {};
				node.server.close();
				node._inputNodes = [];
			} else {
				node.closing = true;
				node.server.close();
				if (node.tout) {
					clearTimeout(node.tout);
				}
			}
		});
	}


	RED.nodes.registerType("ws-listener-auth0", WebSocketListenerNode);
	RED.nodes.registerType("ws-client-auth0", WebSocketListenerNode);

	WebSocketListenerNode.prototype.registerInputNode = function(/*Node*/handler) {
		this._inputNodes.push(handler);
	};

	WebSocketListenerNode.prototype.removeInputNode = function(/*Node*/handler) {
		this._inputNodes.forEach(function(node, i, inputNodes) {
			if (node === handler) {
				inputNodes.splice(i, 1);
			}
		});
	};

	WebSocketListenerNode.prototype.handleEvent = function(id, /*socket*/socket, /*String*/event, /*Object*/data, /*Object*/flags) {
		var msg;
		if (this.wholemsg) {
			try {
				msg = JSON.parse(data);
			} catch(err) {
				msg = {
					payload : data
				};
			}
		} else {
			msg = {
				payload : data
			};
		}
		msg._session = {
			type : "websocket",
			id : id
		};
		for (var i = 0; i < this._inputNodes.length; i++) {
			this._inputNodes[i].send(msg);
		}
	};

	WebSocketListenerNode.prototype.broadcast = function(data) {
		try {
			if (this.isServer) {
				for (var i = 0; i < this.server.clients.length; i++) {
					this.server.clients[i].send(data);
				}
			} else {
				this.server.send(data);
			}
		} catch(e) {// swallow any errors
			this.warn("ws:" + i + " : " + e);
		}
	};

	WebSocketListenerNode.prototype.reply = function(id, data) {
		var session = this._clients[id];
		if (session) {
			try {
				session.send(data);
			} catch(e) {// swallow any errors
			}
		}
	};

	function WebSocketInNode(n) {
		RED.nodes.createNode(this, n);
		this.server = (n.client) ? n.client : n.server;
		var node = this;

		this.serverConfig = RED.nodes.getNode(this.server);
		if (this.serverConfig) {
			this.serverConfig.registerInputNode(this);

			// TODO: nls
			this.serverConfig.on('opened', function(n) {
				node.status({
					fill : "green",
					shape : "dot",
					text : "connected " + n
				});
			});
			this.serverConfig.on('erro', function() {
				node.status({
					fill : "red",
					shape : "ring",
					text : "error"
				});
			});
			this.serverConfig.on('closed', function() {
				node.status({
					fill : "red",
					shape : "ring",
					text : "disconnected"
				});
			});
		} else {
			this.error(RED._("websocket.errors.missing-conf"));
		}

		this.on('close', function() {
			node.serverConfig.removeInputNode(node);
		});

	}


	RED.nodes.registerType("ws-in-auth0", WebSocketInNode);

	function WebSocketOutNode(n) {
		RED.nodes.createNode(this, n);
		var node = this;
		this.server = (n.client) ? n.client : n.server;
		this.serverConfig = RED.nodes.getNode(this.server);
		if (!this.serverConfig) {
			this.error(RED._("websocket.errors.missing-conf"));
		} else {
			// TODO: nls
			this.serverConfig.on('opened', function(n) {
				node.status({
					fill : "green",
					shape : "dot",
					text : "connected " + n
				});
			});
			this.serverConfig.on('erro', function() {
				node.status({
					fill : "red",
					shape : "ring",
					text : "error"
				});
			});
			this.serverConfig.on('closed', function() {
				node.status({
					fill : "red",
					shape : "ring",
					text : "disconnected"
				});
			});
		}
		this.on("input", function(msg) {
			var payload;
			if (this.serverConfig.wholemsg) {
				delete msg._session;
				payload = JSON.stringify(msg);
			} else if (msg.hasOwnProperty("payload")) {
				if (!Buffer.isBuffer(msg.payload)) {// if it's not a buffer make sure it's a string.
					payload = RED.util.ensureString(msg.payload);
				} else {
					payload = msg.payload;
				}
			}
			if (payload) {
				if (msg._session && msg._session.type == "websocket") {
					node.serverConfig.reply(msg._session.id, payload);
				} else {
					node.serverConfig.broadcast(payload, function(error) {
						if (!!error) {
							node.warn(RED._("websocket.errors.send-error") + inspect(error));
						}
					});
				}
			}
		});
	}


	RED.nodes.registerType("ws-out-auth0", WebSocketOutNode);
};
