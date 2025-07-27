const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const MCPVersionManager = require('./MCPVersionManager');

/**
 * MCPClient - Core class for MCP (Model Context Protocol) communication via STDIO
 * Handles JSON-RPC protocol communication with MCP servers with version negotiation
 */
class MCPClient extends EventEmitter {
    /**
     * Initialize MCPClient with server configuration
     * @param {Object} serverConfig - Configuration for the MCP server
     * @param {string} serverConfig.command - Command to spawn the MCP server
     * @param {string[]} [serverConfig.args] - Arguments for the server command
     * @param {Object} [serverConfig.env] - Environment variables for the server
     * @param {string} [serverConfig.cwd] - Working directory for the server
     * @param {number} [serverConfig.timeout] - Timeout for operations in milliseconds
     * @param {string} [serverConfig.name] - Human-readable name for the server
     */
    constructor(serverConfig) {
        super();
        
        this.config = {
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
            cwd: serverConfig.cwd || process.cwd(),
            timeout: serverConfig.timeout || 30000,
            name: serverConfig.name || 'MCP Server'
        };
        
        // Connection state
        this.process = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectDelay = 1000;
        
        // Message handling
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.buffer = '';
        
        // Server capabilities
        this.serverInfo = null;
        this.tools = new Map();
        this.resources = new Map();
        this.prompts = new Map();
        
        // Version management
        this.versionManager = new MCPVersionManager();
        this.negotiatedVersion = null;
        this.versionCapabilities = null;
        this.protocolVersion = '2024-11-05'; // Default fallback
        
        // Set up version manager event handlers
        this._setupVersionManagerEvents();
        
        // Bind methods to preserve context
        this._handleProcessData = this._handleProcessData.bind(this);
        this._handleProcessError = this._handleProcessError.bind(this);
        this._handleProcessClose = this._handleProcessClose.bind(this);
    }
    
    /**
     * Establish STDIO connection to MCP server
     * @returns {Promise<Object>} Server initialization response
     */
    async connect() {
        if (this.connected) {
            return this.serverInfo;
        }
        
        if (this.connecting) {
            throw new Error('Connection already in progress');
        }
        
        this.connecting = true;
        this.emit('connecting');
        
        try {
            // Spawn the MCP server process
            this.process = spawn(this.config.command, this.config.args, {
                env: { ...process.env, ...this.config.env },
                cwd: this.config.cwd,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            // Set up event handlers
            this.process.stdout.on('data', this._handleProcessData);
            this.process.stderr.on('data', this._handleProcessError);
            this.process.on('close', this._handleProcessClose);
            this.process.on('error', this._handleProcessError);
            
            // Initialize the MCP protocol with version negotiation
            const initResponse = await this._initializeWithVersionNegotiation();
            
            this.serverInfo = initResponse;
            this.connected = true;
            this.connecting = false;
            this.reconnectAttempts = 0;
            
            // Send initialized notification
            await this._sendNotification('initialized', {});
            
            // Discover server capabilities
            await this._discoverCapabilities();
            
            this.emit('connected', {
                serverInfo: this.serverInfo,
                negotiatedVersion: this.negotiatedVersion,
                versionCapabilities: this.versionCapabilities
            });
            return this.serverInfo;
            
        } catch (error) {
            this.connecting = false;
            this.connected = false;
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Clean shutdown of connection
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.connected && !this.process) {
            return;
        }
        
        this.emit('disconnecting');
        
        try {
            // Send shutdown notification if connected
            if (this.connected) {
                await this._sendNotification('shutdown', {});
            }
        } catch (error) {
            // Ignore errors during shutdown
        }
        
        // Clean up process
        if (this.process) {
            this.process.removeAllListeners();
            this.process.kill('SIGTERM');
            
            // Force kill after timeout
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
            
            this.process = null;
        }
        
        // Reset state
        this.connected = false;
        this.connecting = false;
        this.buffer = '';
        this.pendingRequests.clear();
        this.tools.clear();
        this.resources.clear();
        this.prompts.clear();
        this.serverInfo = null;
        this.negotiatedVersion = null;
        this.versionCapabilities = null;
        
        this.emit('disconnected');
    }
    
    /**
     * Check connection status
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this.connected && this.process && !this.process.killed;
    }
    
    /**
     * Get available tools from server
     * @returns {Promise<Array>} List of available tools
     */
    async listTools() {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        try {
            const response = await this._sendRequest('tools/list', {});
            
            // Update local tools cache
            this.tools.clear();
            if (response.tools) {
                response.tools.forEach(tool => {
                    this.tools.set(tool.name, tool);
                });
            }
            
            return response.tools || [];
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Invoke a specific tool
     * @param {string} name - Tool name
     * @param {Object} [arguments_] - Tool arguments
     * @returns {Promise<Object>} Tool execution result
     */
    async callTool(name, arguments_ = {}) {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        if (!this.tools.has(name)) {
            // Try to refresh tools list
            await this.listTools();
            if (!this.tools.has(name)) {
                throw new Error(`Tool '${name}' not found`);
            }
        }
        
        try {
            const response = await this._sendRequest('tools/call', {
                name: name,
                arguments: arguments_
            });
            
            this.emit('toolCalled', { name, arguments: arguments_, result: response });
            return response;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Get available resources
     * @returns {Promise<Array>} List of available resources
     */
    async listResources() {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        try {
            const response = await this._sendRequest('resources/list', {});
            
            // Update local resources cache
            this.resources.clear();
            if (response.resources) {
                response.resources.forEach(resource => {
                    this.resources.set(resource.uri, resource);
                });
            }
            
            return response.resources || [];
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Read a specific resource
     * @param {string} uri - Resource URI
     * @returns {Promise<Object>} Resource content
     */
    async readResource(uri) {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        try {
            const response = await this._sendRequest('resources/read', {
                uri: uri
            });
            
            this.emit('resourceRead', { uri, content: response });
            return response;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Get available prompt templates
     * @returns {Promise<Array>} List of available prompts
     */
    async listPrompts() {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        try {
            const response = await this._sendRequest('prompts/list', {});
            
            // Update local prompts cache
            this.prompts.clear();
            if (response.prompts) {
                response.prompts.forEach(prompt => {
                    this.prompts.set(prompt.name, prompt);
                });
            }
            
            return response.prompts || [];
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Get a specific prompt template
     * @param {string} name - Prompt name
     * @param {Object} [arguments_] - Prompt arguments
     * @returns {Promise<Object>} Prompt content
     */
    async getPrompt(name, arguments_ = {}) {
        if (!this.connected) {
            throw new Error('Not connected to MCP server');
        }
        
        if (!this.prompts.has(name)) {
            // Try to refresh prompts list
            await this.listPrompts();
            if (!this.prompts.has(name)) {
                throw new Error(`Prompt '${name}' not found`);
            }
        }
        
        try {
            const response = await this._sendRequest('prompts/get', {
                name: name,
                arguments: arguments_
            });
            
            this.emit('promptRetrieved', { name, arguments: arguments_, content: response });
            return response;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * Attempt to reconnect to the server
     * @returns {Promise<Object>} Server initialization response
     */
    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            throw new Error(`Maximum reconnection attempts (${this.maxReconnectAttempts}) exceeded`);
        }
        
        this.reconnectAttempts++;
        this.emit('reconnecting', this.reconnectAttempts);
        
        // Wait before reconnecting
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay * this.reconnectAttempts));
        
        try {
            await this.disconnect();
            return await this.connect();
        } catch (error) {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                return await this.reconnect();
            }
            throw error;
        }
    }
    
    /**
     * Get server information
     * @returns {Object|null} Server info or null if not connected
     */
    getServerInfo() {
        return this.serverInfo;
    }
    
    /**
     * Get negotiated protocol version
     * @returns {string|null} Negotiated version or null if not connected
     */
    getNegotiatedVersion() {
        return this.negotiatedVersion;
    }
    
    /**
     * Get version capabilities
     * @returns {Object|null} Version capabilities or null if not connected
     */
    getVersionCapabilities() {
        return this.versionCapabilities;
    }
    
    /**
     * Get version manager instance
     * @returns {MCPVersionManager} Version manager
     */
    getVersionManager() {
        return this.versionManager;
    }
    
    /**
     * Get cached tools
     * @returns {Map} Map of tool name to tool definition
     */
    getCachedTools() {
        return new Map(this.tools);
    }
    
    /**
     * Get cached resources
     * @returns {Map} Map of resource URI to resource definition
     */
    getCachedResources() {
        return new Map(this.resources);
    }
    
    /**
     * Get cached prompts
     * @returns {Map} Map of prompt name to prompt definition
     */
    getCachedPrompts() {
        return new Map(this.prompts);
    }
    
    // Private methods
    
    /**
     * Set up version manager event handlers
     * @private
     */
    _setupVersionManagerEvents() {
        this.versionManager.on('versionNegotiated', (result) => {
            this.emit('versionNegotiated', result);
        });
        
        this.versionManager.on('deprecationWarning', (warning) => {
            this.emit('versionWarning', warning);
        });
    }
    
    /**
     * Initialize MCP protocol with version negotiation
     * @private
     */
    async _initializeWithVersionNegotiation() {
        try {
            // First, try to get server version information
            let serverVersions = null;
            let negotiationResult = null;
            
            // Attempt version negotiation by trying different approaches
            try {
                // Try the standard initialize with our preferred version first
                const initParams = this.versionManager.createInitializeParams(
                    this.versionManager.currentVersion,
                    {
                        name: 'VSWizard',
                        version: '1.0.0'
                    }
                );
                
                const response = await this._sendRequest('initialize', initParams);
                
                // Check if server responded with version information
                if (response.protocolVersion) {
                    serverVersions = [response.protocolVersion];
                } else if (response.capabilities?.protocolVersions) {
                    serverVersions = response.capabilities.protocolVersions;
                } else {
                    // Assume server supports our version if it responded successfully
                    serverVersions = [this.versionManager.currentVersion];
                }
                
                // Negotiate version
                negotiationResult = this.versionManager.negotiateVersion(serverVersions);
                this.negotiatedVersion = negotiationResult.version;
                this.versionCapabilities = negotiationResult.capabilities;
                this.protocolVersion = this.negotiatedVersion;
                
                // If we negotiated a different version, re-initialize
                if (negotiationResult.version !== this.versionManager.currentVersion) {
                    const newInitParams = this.versionManager.createInitializeParams(
                        negotiationResult.version,
                        {
                            name: 'VSWizard',
                            version: '1.0.0'
                        }
                    );
                    
                    return await this._sendRequest('initialize', newInitParams);
                }
                
                return response;
                
            } catch (error) {
                // If initialization failed, try fallback versions
                this.emit('versionNegotiationWarning', {
                    message: 'Primary version negotiation failed, trying fallback versions',
                    error: error.message
                });
                
                return await this._tryFallbackVersions();
            }
            
        } catch (error) {
            this.emit('versionNegotiationError', {
                message: 'Version negotiation failed completely',
                error: error.message
            });
            throw new Error(`Version negotiation failed: ${error.message}`);
        }
    }
    
    /**
     * Try fallback versions if primary negotiation fails
     * @private
     */
    async _tryFallbackVersions() {
        const supportedVersions = this.versionManager.getSupportedVersions();
        let lastError = null;
        
        for (const version of supportedVersions) {
            try {
                const initParams = this.versionManager.createInitializeParams(version, {
                    name: 'VSWizard',
                    version: '1.0.0'
                });
                
                const response = await this._sendRequest('initialize', initParams);
                
                // Success with this version
                this.negotiatedVersion = version;
                this.versionCapabilities = this.versionManager.getVersionCapabilities(version);
                this.protocolVersion = version;
                
                this.emit('versionFallbackSuccess', {
                    version: version,
                    message: `Successfully connected using fallback version ${version}`
                });
                
                return response;
                
            } catch (error) {
                lastError = error;
                this.emit('versionFallbackAttempt', {
                    version: version,
                    error: error.message
                });
                continue;
            }
        }
        
        throw new Error(`All version fallbacks failed. Last error: ${lastError?.message}`);
    }
    
    /**
     * Discover server capabilities by listing tools, resources, and prompts
     * @private
     */
    async _discoverCapabilities() {
        try {
            // Use version capabilities to determine what to discover
            const capabilities = this.versionCapabilities || this.serverInfo.capabilities;
            
            // Discover tools if server and version support them
            if (capabilities?.tools && this.serverInfo.capabilities?.tools) {
                await this.listTools();
            }
            
            // Discover resources if server and version support them
            if (capabilities?.resources && this.serverInfo.capabilities?.resources) {
                await this.listResources();
            }
            
            // Discover prompts if server and version support them
            if (capabilities?.prompts && this.serverInfo.capabilities?.prompts) {
                await this.listPrompts();
            }
        } catch (error) {
            // Don't fail connection if capability discovery fails
            this.emit('warning', `Failed to discover some capabilities: ${error.message}`);
        }
    }
    
    /**
     * Send a JSON-RPC request with version validation
     * @private
     */
    async _sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId;
            const message = {
                jsonrpc: '2.0',
                id: id,
                method: method,
                params: params
            };
            
            // Validate message format if we have a negotiated version
            if (this.negotiatedVersion) {
                try {
                    const validation = this.versionManager.validateMessage(message, this.negotiatedVersion);
                    if (!validation.valid) {
                        reject(new Error(`Message validation failed: ${validation.errors.join(', ')}`));
                        return;
                    }
                    
                    // Log warnings if any
                    if (validation.warnings.length > 0) {
                        this.emit('messageValidationWarning', {
                            method: method,
                            warnings: validation.warnings
                        });
                    }
                } catch (validationError) {
                    this.emit('messageValidationError', {
                        method: method,
                        error: validationError.message
                    });
                }
            }
            
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout for method '${method}'`));
            }, this.config.timeout);
            
            // Store pending request
            this.pendingRequests.set(id, { resolve, reject, timeout, method });
            
            // Send message
            this._sendMessage(message);
        });
    }
    
    /**
     * Send a JSON-RPC notification with version validation
     * @private
     */
    async _sendNotification(method, params) {
        const message = {
            jsonrpc: '2.0',
            method: method,
            params: params
        };
        
        // Validate message format if we have a negotiated version
        if (this.negotiatedVersion) {
            try {
                const validation = this.versionManager.validateMessage(message, this.negotiatedVersion);
                if (!validation.valid) {
                    this.emit('notificationValidationError', {
                        method: method,
                        errors: validation.errors
                    });
                    return;
                }
                
                // Log warnings if any
                if (validation.warnings.length > 0) {
                    this.emit('messageValidationWarning', {
                        method: method,
                        warnings: validation.warnings
                    });
                }
            } catch (validationError) {
                this.emit('messageValidationError', {
                    method: method,
                    error: validationError.message
                });
            }
        }
        
        this._sendMessage(message);
    }
    
    /**
     * Send a message to the server
     * @private
     */
    _sendMessage(message) {
        if (!this.process || !this.process.stdin) {
            throw new Error('No active connection to send message');
        }
        
        const messageStr = JSON.stringify(message) + '\n';
        this.process.stdin.write(messageStr);
    }
    
    /**
     * Handle data from server stdout
     * @private
     */
    _handleProcessData(data) {
        this.buffer += data.toString();
        
        // Process complete messages
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const messageStr = this.buffer.substring(0, newlineIndex).trim();
            this.buffer = this.buffer.substring(newlineIndex + 1);
            
            if (messageStr) {
                // Skip non-JSON lines (shell prompts, npm output, etc.)
                if (!messageStr.startsWith('{') && !messageStr.startsWith('[')) {
                    // Log non-JSON output for debugging but don't treat as error
                    this.emit('nonJsonOutput', messageStr);
                    continue;
                }
                
                try {
                    const message = JSON.parse(messageStr);
                    this._handleMessage(message);
                } catch (error) {
                    // Only emit error for lines that look like they should be JSON
                    if (messageStr.startsWith('{') || messageStr.startsWith('[')) {
                        this.emit('error', new Error(`Failed to parse message: ${error.message}, Content: "${messageStr.substring(0, 100)}..."`));
                    } else {
                        // Log unexpected output for debugging
                        this.emit('nonJsonOutput', messageStr);
                    }
                }
            }
        }
    }
    
    /**
     * Handle parsed JSON-RPC message with version validation
     * @private
     */
    _handleMessage(message) {
        // Validate incoming message if we have a negotiated version
        if (this.negotiatedVersion) {
            try {
                const validation = this.versionManager.validateMessage(message, this.negotiatedVersion);
                if (!validation.valid) {
                    this.emit('incomingMessageValidationError', {
                        message: message,
                        errors: validation.errors
                    });
                    return;
                }
                
                // Log warnings if any
                if (validation.warnings.length > 0) {
                    this.emit('messageValidationWarning', {
                        method: message.method || 'response',
                        warnings: validation.warnings
                    });
                }
            } catch (validationError) {
                this.emit('messageValidationError', {
                    method: message.method || 'response',
                    error: validationError.message
                });
            }
        }
        
        if (message.id !== undefined) {
            // This is a response to a request
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(message.id);
                
                if (message.error) {
                    pending.reject(new Error(`${pending.method}: ${message.error.message || 'Unknown error'}`));
                } else {
                    pending.resolve(message.result);
                }
            }
        } else if (message.method) {
            // This is a notification from the server
            this.emit('notification', message);
            
            // Handle specific notifications (check version support)
            const capabilities = this.versionCapabilities;
            switch (message.method) {
                case 'notifications/tools/list_changed':
                    if (capabilities?.notifications) {
                        this.emit('toolsChanged');
                    }
                    break;
                case 'notifications/resources/list_changed':
                    if (capabilities?.notifications) {
                        this.emit('resourcesChanged');
                    }
                    break;
                case 'notifications/prompts/list_changed':
                    if (capabilities?.notifications) {
                        this.emit('promptsChanged');
                    }
                    break;
            }
        }
    }
    
    /**
     * Handle process errors
     * @private
     */
    _handleProcessError(error) {
        const errorMessage = error.toString();
        
        // Filter out common non-error stderr output
        const commonNonErrors = [
            'npm WARN',
            'npm notice',
            'npm info',
            'added ',
            'audited ',
            'found 0 vulnerabilities',
            'up to date',
            '> @upstash',
            '> node dis',
            'Context7 Documentation MCP Server running on stdio',
            'MCP Server running on stdio',
            'Server running on stdio',
            'running on stdio'
        ];
        
        const isActualError = !commonNonErrors.some(pattern =>
            errorMessage.toLowerCase().includes(pattern.toLowerCase())
        );
        
        if (isActualError) {
            this.emit('error', new Error(`MCP Server error: ${errorMessage}`));
            
            // Only attempt reconnection for actual connection errors, not server status messages
            const isConnectionError = errorMessage.toLowerCase().includes('connection') ||
                                    errorMessage.toLowerCase().includes('econnrefused') ||
                                    errorMessage.toLowerCase().includes('timeout') ||
                                    errorMessage.toLowerCase().includes('network');
            
            if (this.connected && isConnectionError && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnect().catch(err => {
                    this.emit('error', err);
                });
            }
        } else {
            // Log non-error stderr output for debugging
            this.emit('stderrOutput', errorMessage);
        }
    }
    
    /**
     * Handle process close
     * @private
     */
    _handleProcessClose(code, signal) {
        const wasConnected = this.connected;
        this.connected = false;
        this.connecting = false;
        
        // Clear pending requests
        this.pendingRequests.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
        });
        this.pendingRequests.clear();
        
        this.emit('processClose', { code, signal });
        
        if (wasConnected) {
            this.emit('disconnected');
            
            // Only attempt reconnection for unexpected crashes, not normal exits
            // Code 0 = normal exit, Code 1 = general error (could be server status message)
            // Only reconnect for codes that indicate actual crashes (SIGKILL, SIGSEGV, etc.)
            const shouldReconnect = code !== 0 && code !== 1 &&
                                  signal !== 'SIGTERM' && signal !== 'SIGINT' &&
                                  this.reconnectAttempts < this.maxReconnectAttempts;
            
            if (shouldReconnect) {
                this.reconnect().catch(err => {
                    this.emit('error', err);
                });
            }
        }
    }
}

module.exports = MCPClient;