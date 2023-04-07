
const WebSocket = require('ws')
const max_channel_size = 8;
const start_date = new Date()

const OP_ERROR = 1;
const OP_NAME = 2;
const OP_SAY = 3;
const OP_LIST = 4;
const OP_JOIN = 5;
const OP_LEAVE = 6;

var opcodes = {
	OP_ERROR,
	OP_NAME,
	OP_SAY,
	OP_LIST,
	OP_JOIN,
	OP_LEAVE
}

function help_message() {
	const delta = new Date().getTime() - start_date.getTime()
	return "Server online since: " + start_date + "\n" +
		"Uptime: " + delta / 1E3 + " seconds.\n\n" +
		"====== Commands ======\n" +
		"Commands are binary formatted messages, in the following format:\n\n" +

		"|-| 1 Byte - opcode\n" +
		"|--------------------| Four (4) 32-Bit Floats - Position\n" +
		"|--------------------| Four (4) 32-Bit Floats - Orientation\n" +
		"|--------------------| Four (4) 32-Bit Floats - Velocity\n" +
		"|--------------------| Four (4) 32-Bit Floats - Angular Velocity\n" +
		"|----| One (1) 32-Bit Float - Uptime in miliseconds\n" +
		"|----| 32-Bit (4-Byte) Unsigned Int - Audio Data Length (bytes) \n" +
		"|----| 32-Bit (4-Byte) Float - Time Since Last Audio Data (seconds)\n" +
		"|--------...---------| X 8-Bit (1-Byte) Unsigned Integers - Synthetic Audio Data\n" +
		"|--------...---------| Remaining Bytes - Base 64 Encoded JSON meta data string\n\n" +

		"The metadata section is has the following JSON fields for each opcode:\n\n" +
		"opcode 1 - {error} - Server status message, or error messages for invalid commands.\n" +
		"opcode 2 - {name} - Name to reserve (limited to regex: [A-z0-9][A-z0-9]*). You cannot change your name once you've joined a channel.\n" +
		"opcode 3 - {message} or {name, message} - Name of messenger with message from server, or just message to say to the current channel.\n" +
		"opcode 4 - {[channels]} or {channel, [users]} - Fetches the publicly available channel names list or, if you've already joined a channel, feteches the names of other users in that channel.\n" +
		"opcode 5 - {channel, password} - Attempts to join or create channel (limited to regex: [A-z0-9][A-z0-9]*), optionally with password (also limited to regex: [A-z0-9][A-z0-9]*). One channel per connection.\n" +
		"opcode 6 - {user} - If in a channel, then parts that channel; optionally, user is defined as the name of someone who left.\n" +
		"====== End of Commands ======\n"
}

exports.create = function () {
	var start_time = new Date().getTime()
	var users = []
	var channels = []

	class Channel {
		constructor(name, password) {
			this.name = name;
			this.password = password;
			this.users = [];
		}
		userJoin(user) {
			if (this.users.length >= max_channel_size) {
				user.send(OP_ERROR, { error: 'Channel "' + this.name + '" is at max capacity.' });
			} else {
				this.users.push(user);
				user.channel = this;
				const user_list = this.users.map((u) => { return { name: u.name, ip: u.client.remoteAddress }; });
				this.users.forEach((u) => u.send(OP_JOIN, { name:user.name, channel: this.name, users: user_list }));

				if(!this.password) {
					const passwordless_channels = channels.filter((channel) => !channel.password).map((channel) => { return { name: channel.name, occupancy: channel.users.length, max: max_channel_size } })
					const others_in_lobby = users.filter((u) => u.name != user.name && !u.channel);
					console.log(OP_LIST, { channels: passwordless_channels })
					others_in_lobby.forEach(u=>u.send(OP_LIST, { channels: passwordless_channels }))
				}
			}
		}
		userLeave(user) {
			this.users.forEach((u) => u.send(OP_LEAVE, { name: user.name, ip: user.client.remoteAddress }));
			this.users = this.users.filter((u) => u.name != user.name);
			user.channel = undefined;

			if (this.users.length == 0) {
				const this_name = this.name;
				channels = channels.filter((channel) => channel.name != this_name);
			}

			if(!this.password) {
				const names = channels.filter((channel) => !channel.password).map((channel) => { return { name: channel.name, occupancy: channel.users.length, max: max_channel_size } })
				const in_lobby = users.filter((u) => !u.channel);
				in_lobby.forEach(u=>u.send(OP_LIST, { channels: names }))
			}
		}
	}



	class User {
		constructor(client) {
			this.channel = null;
			this.spacio_temporal = new Uint8Array(4*4*4).fill(0);

			this.voice_audio = null
			this.last_audio = 0
			this.client = client;
			this.assignRandomName();
		}
		send(opcode, metadata, from, signal) {
			var json_string = JSON.stringify(metadata)
			var audio = signal ? signal : (this.voice_audio ? this.voice_audio : [])
			var size = 1 + 4 * 4 * 4 + 4 * 3 + audio.length + json_string.length;
			var message = new DataView(new Uint8Array(size).buffer)

			var offset = 0;
			message.setUint8(offset, opcode)
			offset+=1
			for (var byte of from ? from : this.spacio_temporal) {
				message.setUint8(offset++, byte)
			}
			message.setFloat32(offset, new Date().getTime()-start_time)
			offset += 4
			message.setUint32(offset, audio.length)
			offset += 4
			message.setFloat32(offset, this.last_audio)
			offset += 4
			for (var i = 0; i < audio.length; i++) {
				message.setUint8(offset, audio[i])
				offset += 1
			}
			var index = 0;
			for (var char of json_string) {
				message.setUint8(offset, json_string.charCodeAt(index++))
				offset += 1;
			}
			this.client.send(message.buffer, { binary: true });
		}
		joinChannel(name, password) {

			var regex = /[A-z0-9][A-z0-9]*/;
			var found = name.match(regex);
			if (!found || !found.length && found[0].length != name.length) {
				this.send(OP_ERROR, { error: 'Invalid channel name. Please use the following regular expression:\n' + regex });
				return;
			}

			if(password) {
				found = password.match(regex);
				if (!found || !found.length && found[0].length != password.length) {
					this.send(OP_ERROR, { error: 'Invalid channel password. Please use the following regular expression:\n' + regex });
					return;
				}
			}

			for (const channel of channels) {
				if (channel.name == name) {
					if (!channel.password && password) {
						this.send(OP_ERROR, { error: 'Failed to join channel. Channel does not have a password.' });
						return;
					} else if ((channel.password && !password) || (channel.password && channel.password != password)) {
						this.send(OP_ERROR, { error: 'Invalid password.' });
						return;
					} else {
						channel.userJoin(this);
						return;
					}
				}
			}

			const channel = new Channel(name, password);
			channels.push(channel);
			channel.userJoin(this);

			if(!channel.password) {
				const names = channels.filter((channel) => !channel.password).map((channel) => { return { name: channel.name, occupancy: channel.users.length, max: max_channel_size } })
				users.filter(user=>!user.channel).forEach(user=>user.send(OP_LIST, { channels: names }));
			}
		}
		say(message) {
			if (!this.channel) {
				this.send(OP_ERROR, { error: 'Cannot say anything while not in a channel.' });
			} else {
				const our_name = this.name;
				const our_ip = this.client.remoteAddress;
				const payload = {}
				payload.name = our_name
				if(message) {
					payload.message = message
					payload.ip = our_ip
				}

				const user_voice = this.voice_audio
				const since_last = this.last_audio
				const spacio_temporal = this.spacio_temporal
				this.channel.users.forEach((user) => {
					user.send(OP_SAY, payload, spacio_temporal, user_voice, since_last);
				});
				this.voice_audio = null
				this.last_audio = 0
			}
		}
		assignRandomName() {
			var name = "User" + Math.floor(Math.random() * 999999);
			for (const user of users) {
				if (user.name === name) {
					this.assignRandomName();
					return;
				}
			}
			this.assignName(name);
		}
		assignName(name) {
			for (const user of users) {
				if (user.name == name) {
					this.send(OP_ERROR, { error: "Nickname '" + name + "' already reserverd." });
					return;
				}
			}
			const regex = /[A-z0-9][A-z0-9]*/;
			const found = name.match(regex);
			//console.log(found)
			if (found && found.length > 0 && found[0].length == name.length) {
				this.name = name;
				this.send(OP_NAME, { name });
				return name;
			}

			else
				this.send(OP_ERROR, { error: "Invalid nickname. Please use the following regular expression: [A-z0-9][A-z0-9]*\n" + regex });
			this.client.close();
		}
	}

	return function (client) {
		console.info(client.remoteAddress, 'Echo Chambers connection established.');

		client.user = new User(client);
		users.push(client.user);
		const names = channels.filter((channel) => !channel.password).map((channel) => { return { name: channel.name, occupancy: channel.users.length, max: max_channel_size } })
		client.user.send(OP_LIST, { channels: names })
		// client.user.send(OP_ERROR, { error: help_message() });

		client.on('close', function () {
			client.emit('command', { opcode: OP_LEAVE });
			users = users.filter((u) => u.name != client.user.name);
		});

		// Buffer network IO and emit message events
		client.on('message', function (data, isBinary) {
			function ab2str(buf) {
				return String.fromCharCode.apply(null, new Uint8Array(buf));
			}
			try {
				var offset = 0
				var bytes = new Uint8Array(data)
				var buf = bytes.buffer;
				var view = new DataView(buf);
				var opcode = bytes.at(offset)
				offset++
				var spacio_temporal = bytes.slice(offset, offset+4*4*4)
				offset+=4*4*4

				var uptime = view.getFloat32(offset)
				offset += 4
				var length = view.getUint32(offset)
				offset += 4
				var since = view.getFloat32(offset)
				offset += 4
				var signal = new Uint8Array(length)
				for (var i = 0; i < length; i++) signal[i] = view.getUint8(offset + i);
				offset += length
				var string = ab2str(bytes.slice(offset));
				var metadata = string ? JSON.parse(string) : {}

				var message = {
					opcode,
					spacio_temporal,
					since,
					signal,
					metadata,
				}
				client.user.spacio_temporal = spacio_temporal
				client.user.last_audio = since
				client.user.voice_audio = new Uint8Array(signal)
				client.emit('command', message);
			} catch (e) {
				console.log(e)
				client.user.send(OP_ERROR, { error: 'Invalid command format. Disconnecting.' });
				client.close();
			}
		});

		// Parse messages
		client.on('command', function (message) {
			var opcode = message.opcode
			var optype = Object.keys(opcodes).find(key => opcodes[key] === message.opcode);
			// console.log("Echo Chambers Message: " + new Date().getTime() + " " + client.remoteAddress + " " + (client.user ? client.user.name + " " : "") + optype)
			// console.log(message)
			var metadata = message.metadata

			// console.log(JSON.stringify(command))
			if (!opcode) {
				client.user.send(OP_ERROR, { error: 'Invalid command.' });
			}
			else if (opcode === OP_NAME) {
				if (client.user.channel) {
					client.user.send(OP_ERROR, { error: 'Cannot change nickname while currently in a channel.' });
				} else if (metadata.name) {
					if (metadata.name == client.user.name)
						client.user.send(OP_ERROR, { error: 'Cannot change nickname. "' + client.user.name + '" is already your user name.' });
					else
						client.user.assignName(metadata.name)
				} else {
					client.user.send(OP_ERROR, { error: 'Please provide a valid name (limited to regex: [A-z0-9][A-z0-9]*)...' });
				}
			} else if (opcode === OP_LIST) {
				if (client.user.channel) {
					const user_list = client.user.channel.users.map((u) => { return { name: u.name, ip: u.client.remoteAddress } })
					client.user.send(OP_LIST, { channel: client.user.channel.name, users: user_list });
				} else {
					const names = channels.filter((channel) => !channel.password).map((channel) => { return { name: channel.name, occupancy: channel.users.length, max: max_channel_size } })
					client.user.send(OP_LIST, { channels: names });
				}
			} else if (opcode === OP_LEAVE) {
				if (client.user.channel) {
					client.user.channel.userLeave(client.user);
				} else if (client.readyState == WebSocket.OPEN) {
					client.close();
				} else {
					users = users.filter((u) => u.name != client.user.name)
				}
			} else if (opcode === OP_JOIN) {
				if (client.user.channel) {
					client.user.send(OP_ERROR, { error: 'Cannot join channel while currently in a channel.' });
				}
				else if (!metadata.channel) {
					client.user.send(OP_ERROR, { error: 'Please provide a channel name...' });
				}
				else {
					client.user.joinChannel(metadata.channel, metadata.password)
				}
			} else if (opcode === OP_SAY) {
				client.user.say(metadata.message)
			}
			else {
				client.user.send(OP_ERROR, { error: 'Command not found. '+help_message() });
			}
		});
		// Log all errors, do not die
		// client.on('error', function () {
		// });

		// // Deliver answers over the network by default
		// client.deliver = function (message) {
		// 	console.debug(client.remoteAddress, client.name, '<<<', out);
		// 	client.send(out);
		// };
	};
};