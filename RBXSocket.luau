--!strict

local HttpService = game:GetService("HttpService")

local Socket = {}
Socket.__index = Socket

type socketOptions = {
	closeOnGameClose: boolean?, -- Unless false, socket will automatically invoke :close() when the game is closing.
	requestHeaders: { [string]: string }?, -- A list of optional headers to send on every request (also accessible later with Socket.requestHeaders).
	maxPoolSize: number, -- A max value for the connection pool size (the server sets whatever it wants).
	bufferTime: number, -- The amount of time in seconds to yield until a request is sent (higher time reduces the amount of connections being sent, but will increase the delay between data being sent an recieved).
}

local states: { [string]: number } = {
	CONNECTING = 0,
	OPEN = 1,
	CLOSING = 2,
	CLOSED = 3,
}
Socket.states = states

local function mergeDictionaries(t1, t2)
	local t3 = table.clone(t1)
	for k, v in t2 do
		t3[k] = v
	end

	return t3
end

function Socket.new(url: string, options: socketOptions?)
	local socketOptions = options or {} :: socketOptions

	local self = setmetatable({}, Socket)
	self.url = url
	self.maxPoolSize = socketOptions.maxPoolSize or 2
	self.requestHeaders = socketOptions.requestHeaders or {}
	self.state = states.CONNECTING
	self.bufferedAmount = 0
	self.bufferTime = socketOptions.bufferTime or 0

	self.__socketId = nil :: string?
	self.__maxPoolSize = 0
	self.__poolSize = 0
	self.__buffer = {} :: { any }
	self.__bufferThread = nil :: thread?
	self.__events = {
		open = Instance.new("BindableEvent"),
		close = Instance.new("BindableEvent"),
		error = Instance.new("BindableEvent"),
		message = Instance.new("BindableEvent"),
	}

	if socketOptions.closeOnGameClose ~= false then
		self:on("open", function()
			game:BindToClose(function()
				self:close(1001, "game is closing")
			end)
		end)
	end

	task.defer(self.__connect, self)
	return self
end

function Socket:__connect()
	self.state = states.CONNECTING
	local requestSuccess, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = self.url,
		Method = "HEAD",
		Headers = self.requestHeaders,
	})

	if not requestSuccess then
		return self:close(1002, `error while connecting: {response}`)
	end

	if not response.Success then
		return self:close(1002, `{response.StatusCode}: {response.StatusMessage}`)
	end

	local sockedId = response.Headers["socket-id"]
	local maxPoolSize = response.Headers["max-pool-size"]

	if not sockedId or not maxPoolSize then
		return self:close(1002, "server returned malformed data")
	end

	self.__socketId = sockedId
	self.__maxPoolSize = math.max(tonumber(maxPoolSize) or 0, 1)

	self.state = states.OPEN
	self.__events.open:Fire()
	self:__fillConnectionPool()
end

function Socket:__fillConnectionPool()
	if self.state ~= states.OPEN then
		return
	end

	while self.__poolSize < math.min(self.__maxPoolSize, self.maxPoolSize) do
		self:__poll()
	end
end

function Socket:__poll()
	self.__poolSize += 1

	task.defer(function()
		local buffered = table.clone(self.__buffer)
		table.clear(self.__buffer)
		self.bufferedAmount = 0

		local success, response = pcall(HttpService.RequestAsync, HttpService, {
			Url = self.url,
			Method = "PATCH",
			Headers = mergeDictionaries(self.requestHeaders, {
				["Content-Type"] = "application/json",
				["socket-id"] = self.__socketId,
			}),
			Body = HttpService:JSONEncode(buffered),
		})

		if not success then
			-- Add back the data we took to the buffer array.
			for _, data in ipairs(buffered) do
				table.insert(self.__buffer, data)
			end
			self.bufferedAmount += #buffered

			task.wait(1)

			self.__poolSize -= 1
			return self:__fillConnectionPool()
		end

		if response.StatusCode == 404 then
			-- The socketId is no longer valid on the server.
			return self:close(1001, "server closed socket")
		elseif response.StatusCode == 500 then
			-- The socketId is no longer valid on the server.
			return self:close(1001, "internal server error")
		end

		if not response.Success and response.StatusCode ~= 410 then
			return self:__fillConnectionPool()
		end

		local decodeSuccess, result = pcall(HttpService.JSONDecode, HttpService, response.Body)
		if not decodeSuccess then
			return self:__fillConnectionPool()
		end

		for _, data in ipairs(result) do
			self.__events.message:Fire(data)
		end

		self.__poolSize -= 1
		if response.StatusCode == 410 then
			-- The socket was closed by the server.
			return self:close(tonumber(response.Headers["close-code"]), tostring(response.Headers["close-reason"]))
		end

		self:__fillConnectionPool()
	end)
end

function Socket:close(code: number?, reason: string?)
	if self.state == states.CLOSING or self.state == states.CLOSED then
		return
	end

	local closeCode = code or 1000
	self.__events.close:Fire(closeCode, reason)
	self.state = states.CLOSING

	local requestData = {
		Url = self.url,
		Method = "DELETE",
		Headers = mergeDictionaries(self.requestHeaders, {
			["Content-Type"] = "application/json",
			["socket-id"] = self.__socketId,
			["close-code"] = code,
			["close-reason"] = reason,
		}),
	}

	local attempts = 0
	while not pcall(HttpService.RequestAsync, HttpService, requestData) do
		attempts += 1
		if attempts >= 3 then
			break
		end

		task.wait(1)
	end

	self.state = states.CLOSED
	self:terminate()
end

function Socket:terminate()
	if self.state == states.OPEN then
		self.__events.close:Fire(1001, "socket was terminated")
	end
	self.state = states.CLOSED

	for _, bindable in self.__events do
		bindable:Destroy()
	end
end
Socket.Destroy = Socket.terminate

function Socket:send(data: string)
	if self.state ~= states.OPEN then
		if self.state == states.CONNECTING then
			return error("The socket is currently connecting.", 2)
		end

		return
	end

	table.insert(self.__buffer, data)
	self.bufferedAmount += 1

	-- We defer a thread to send the data incase :send() is called multiple times.
	if not self.__bufferThread then
		self.__bufferThread = task.delay(self.bufferTime, function()
			self.__bufferThread = nil
			self:__poll()
		end)
	end
end

function Socket:on(event: "open" | "close" | "error" | "message", callback: () -> nil)
	return self.__events[event].Event:Connect(callback)
end

return Socket
